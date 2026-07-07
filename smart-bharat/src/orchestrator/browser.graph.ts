import { StateGraph, Annotation, MemorySaver, Command, interrupt, START, END } from "@langchain/langgraph";
import { nanoid } from "nanoid";
import { getPlaybook, runAutomatedStep, type Playbook } from "../agents/browser-executor.js";
import { createPlaywrightDriver, type LiveDriver } from "../agents/playwright-driver.js";
import { getProfile, type UserProfile } from "../memory/profile.js";
import { wantsLiveBrowser } from "../config.js";

/**
 * Live browsers are stateful and can't be serialized into the LangGraph checkpointer,
 * so each run's driver lives here, keyed by runId. runStep() looks it up; the driver
 * is closed and removed when the run completes.
 */
const drivers = new Map<string, LiveDriver>();

async function closeDriver(runId: string) {
  const d = drivers.get(runId);
  if (d) {
    drivers.delete(runId);
    await d.close().catch(() => {});
  }
}

/**
 * Browser Automation Agent (spec §2.6) — the CORRECT LangGraph human-in-the-loop
 * pattern. `human_required` steps call interrupt(), which pauses graph execution
 * and hands control back to the frontend ("your turn" card). The graph resumes
 * via Command({ resume }) once the user confirms. No polling, no separate state
 * machine. The agent NEVER logs in, enters OTPs, or submits — those are the
 * interrupt points, by design.
 */

export interface LogEntry {
  index: number;
  type: string;
  detail: string;
  at: string;
  screenshot?: string;
}

const S = Annotation.Root({
  runId: Annotation<string>(),
  playbook: Annotation<Playbook>(),
  profile: Annotation<UserProfile>(),
  live: Annotation<boolean>({ default: () => false, reducer: (_, x) => x }),
  stepIndex: Annotation<number>({ default: () => 0, reducer: (_, x) => x }),
  currentScreenshot: Annotation<string>({ default: () => "", reducer: (_, x) => x }),
  log: Annotation<LogEntry[]>({ default: () => [], reducer: (a, b) => a.concat(b) }),
});

async function runStep(s: typeof S.State) {
  const steps = s.playbook.steps;
  const i = s.stepIndex;
  if (i >= steps.length) return {};
  const step = steps[i];
  const now = new Date().toISOString();

  if (step.type === "human_required") {
    // PAUSE — return control to the human. `note` is whatever the user sends on resume.
    const note = interrupt({
      reason: step.reason,
      instruction: step.instruction,
      stepIndex: i,
      portal: s.playbook.portal_url,
    });
    return {
      stepIndex: i + 1,
      log: [{ index: i, type: "human_required", detail: `✓ ${step.reason}: user completed${note ? ` (${note})` : ""}`, at: now }],
    };
  }

  const result = await runAutomatedStep(step, s.playbook, s.profile, drivers.get(s.runId));
  return {
    stepIndex: i + 1,
    currentScreenshot: result.screenshot,
    log: [{ index: i, type: step.type, detail: result.detail, at: now, screenshot: result.screenshot }],
  };
}

function loop(s: typeof S.State): string {
  return s.stepIndex < s.playbook.steps.length ? "runStep" : END;
}

const graph = new StateGraph(S)
  .addNode("runStep", runStep)
  .addEdge(START, "runStep")
  .addConditionalEdges("runStep", loop, { runStep: "runStep", [END]: END });

const app = graph.compile({ checkpointer: new MemorySaver() });

/** Shape of the value passed to interrupt() in runStep — surfaced as the "your turn" card. */
export interface InterruptPayload {
  reason?: string;
  instruction?: string;
  stepIndex?: number;
  portal?: string;
}

export interface AutomationView {
  runId: string;
  service: string;
  status: "paused" | "done";
  mode: "live" | "sim";
  step_index: number;
  total_steps: number;
  interrupt: InterruptPayload | null;
  screenshot: string;
  log: LogEntry[];
}

interface SnapshotTask {
  interrupts?: { value?: InterruptPayload }[];
}

async function view(runId: string): Promise<AutomationView> {
  const config = { configurable: { thread_id: runId } };
  const snap = await app.getState(config);
  const v = snap.values as typeof S.State;
  const paused = (snap.next?.length ?? 0) > 0;
  let intr: InterruptPayload | null = null;
  if (paused) {
    const task = (snap.tasks as SnapshotTask[] | undefined)?.find((t) => t.interrupts?.length);
    intr = task?.interrupts?.[0]?.value ?? null;
  }
  // Run finished: tear down the live browser if there was one.
  if (!paused) await closeDriver(runId);
  return {
    runId,
    service: v.playbook.service_id,
    status: paused ? "paused" : "done",
    mode: v.live ? "live" : "sim",
    step_index: v.stepIndex,
    total_steps: v.playbook.steps.length,
    interrupt: intr,
    screenshot: v.currentScreenshot,
    log: v.log,
  };
}

export async function startAutomation(serviceId: string, userId: string): Promise<AutomationView> {
  const playbook = await getPlaybook(serviceId);
  if (!playbook) throw new Error(`unknown service "${serviceId}"`);
  const profile = await getProfile(userId);
  const runId = "run_" + nanoid(8);

  // Spin up a real browser if configured. If it can't launch (Playwright/browser
  // missing), fall back to simulation — the graph is identical either way.
  let live = false;
  if (wantsLiveBrowser()) {
    const driver = await createPlaywrightDriver();
    if (driver) { drivers.set(runId, driver); live = true; }
  }

  try {
    await app.invoke({ runId, playbook, profile, live }, { configurable: { thread_id: runId } });
  } catch (e) {
    await closeDriver(runId); // don't leak a browser if the first leg throws
    throw e;
  }
  return view(runId);
}

export async function resumeAutomation(runId: string, note = "done"): Promise<AutomationView> {
  try {
    await app.invoke(new Command({ resume: note }), { configurable: { thread_id: runId } });
  } catch (e) {
    await closeDriver(runId);
    throw e;
  }
  return view(runId);
}

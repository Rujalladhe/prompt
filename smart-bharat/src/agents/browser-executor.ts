import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UserProfile } from "../memory/profile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_DIR = join(__dirname, "../../data/playbooks");

/**
 * Service Registry + executor (spec §6). Each government service is a JSON
 * playbook, not hardcoded logic. The DEFAULT executor here is a SIMULATION — it
 * records what a real Playwright driver would do (navigate, ai_fill) and emits a
 * placeholder "screenshot" — so the human-in-the-loop interrupt architecture is
 * fully demoable without installing browser binaries. To go live, implement the
 * BrowserDriver interface with Playwright and pass it to the graph; the
 * orchestration (interrupt/resume) is unchanged.
 *
 * SAFETY: the agent never performs login, OTP entry, or final submit — those are
 * `human_required` steps handled by the graph via interrupt(). This executor only
 * ever runs `navigate` and `ai_fill` (non-secret fields).
 */

export interface PlaybookStep {
  type: "navigate" | "ai_fill" | "human_required";
  target?: string;
  reason?: string;
  instruction?: string;
  field_map?: Record<string, string>;
  /** Optional explicit CSS selectors per field (field -> selector). Falls back to a
   * heuristic locator when absent, so existing playbooks work unchanged. */
  selectors?: Record<string, string>;
}
export interface Playbook {
  service_id: string;
  aliases: string[];
  portal_url: string;
  required_docs: string[];
  steps: PlaybookStep[];
}

export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  fill(selectorOrField: string, value: string): Promise<void>;
  screenshot(): Promise<string>; // data URL
}

let _playbooks: Playbook[] | null = null;
export async function loadPlaybooks(): Promise<Playbook[]> {
  if (_playbooks) return _playbooks;
  try {
    const files = (await readdir(PLAYBOOK_DIR)).filter((f) => f.endsWith(".json"));
    _playbooks = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(PLAYBOOK_DIR, f), "utf8")) as Playbook));
  } catch {
    _playbooks = [];
  }
  return _playbooks;
}

export async function getPlaybook(serviceId: string): Promise<Playbook | null> {
  return (await loadPlaybooks()).find((p) => p.service_id === serviceId) ?? null;
}

/** Match free-text/voice to a service_id via alias overlap (embedding sim in prod). */
export async function matchService(text: string): Promise<Playbook | null> {
  const t = text.toLowerCase();
  const pbs = await loadPlaybooks();
  let best: { p: Playbook; score: number } | null = null;
  for (const p of pbs) {
    let score = 0;
    for (const a of p.aliases) if (t.includes(a.toLowerCase())) score += a.length;
    if (score && (!best || score > best.score)) best = { p, score };
  }
  return best?.p ?? null;
}

// --- simulation screenshot (a labelled SVG so the UI has a "browser view") ---
function simShot(title: string, subtitle: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='560' height='340'>
    <rect width='560' height='340' fill='#0f1216'/>
    <rect x='0' y='0' width='560' height='34' fill='#20262f'/>
    <circle cx='18' cy='17' r='5' fill='#f0576b'/><circle cx='36' cy='17' r='5' fill='#f5b942'/><circle cx='54' cy='17' r='5' fill='#35c07f'/>
    <text x='90' y='22' fill='#8b95a5' font-family='monospace' font-size='12'>${escapeXml(subtitle)}</text>
    <text x='24' y='150' fill='#e7ecf3' font-family='sans-serif' font-size='22'>${escapeXml(title)}</text>
    <text x='24' y='185' fill='#ff8f3f' font-family='sans-serif' font-size='13'>[simulated browser — Playwright driver plugs in here]</text>
  </svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}
function escapeXml(s: string) {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

export interface StepResult {
  detail: string;
  screenshot: string;
  filled?: Record<string, string>;
}

/** Run a non-human step. Uses `driver` if provided (real Playwright), else simulates. */
export async function runAutomatedStep(
  step: PlaybookStep,
  playbook: Playbook,
  profile: UserProfile,
  driver?: BrowserDriver,
): Promise<StepResult> {
  if (step.type === "navigate") {
    const url = step.target === "portal_url" ? playbook.portal_url : step.target || playbook.portal_url;
    if (driver) await driver.navigate(url);
    return {
      detail: `navigated to ${url}`,
      screenshot: driver ? await driver.screenshot() : simShot(playbook.service_id.replace(/_/g, " "), url),
    };
  }
  if (step.type === "ai_fill") {
    const filled: Record<string, string> = {};
    for (const [field, path] of Object.entries(step.field_map ?? {})) {
      const value = resolveProfilePath(path, profile);
      if (value) {
        if (driver) await driver.fill(step.selectors?.[field] ?? field, value);
        filled[field] = value;
      }
    }
    return {
      detail: `filled ${Object.keys(filled).length} field(s): ${Object.keys(filled).join(", ") || "(none — profile incomplete)"}`,
      filled,
      screenshot: driver ? await driver.screenshot() : simShot("Auto-filling form", playbook.portal_url),
    };
  }
  return { detail: "no-op", screenshot: simShot("", "") };
}

function resolveProfilePath(path: string, profile: UserProfile): string | undefined {
  // e.g. "profile.name" -> canonical_profile.name
  const key = path.replace(/^profile\./, "") as keyof UserProfile["canonical_profile"];
  const v = profile.canonical_profile[key];
  return typeof v === "string" ? v : undefined;
}

import { grievances } from "../db.js";
import { config } from "../config.js";
import { draftFollowUp, draftRti } from "../agents/ombudsman.js";
import type { Grievance, TimelineEntry } from "../schemas.js";

/**
 * SLA escalation worker (spec §2.5). In production this is a BullMQ repeatable
 * job on Redis; for the zero-Redis demo it's an interval scanner with identical
 * logic. On breach:
 *   L0 -> L1: auto-draft + "send" a polite follow-up to the department.
 *   L1 -> L2: auto-draft an RTI application, SURFACE it to the user. Never submit.
 *
 * A second breach window after L1 is required before L2, so escalation is staged
 * rather than firing both at once.
 */

const L2_DELAY_MS = Math.max(config.slaHours * 3600 * 1000 * 0.5, 10 * 1000); // half an SLA window after L1

let timer: NodeJS.Timeout | null = null;

async function escalateOne(g: Grievance, now: Date) {
  const entry = (event: string, detail: string): TimelineEntry => ({
    at: now.toISOString(),
    actor: "system",
    event,
    detail,
  });

  // L0 -> L1: first breach
  if (g.escalation_level === 0) {
    const draft = await draftFollowUp(g);
    await grievances().update(g._id, {
      escalation_level: 1,
      status: "follow_up_sent",
      follow_up_draft: draft,
      timeline: [...g.timeline, entry("sla_breach", `deadline ${g.sla_deadline} passed`), entry("follow_up_sent", "auto-drafted reminder sent to department")],
    });
    console.log(`[sla] ${g._id} escalated L0->L1 (follow-up sent)`);
    return;
  }

  // L1 -> L2: still unresolved a while after the follow-up
  if (g.escalation_level === 1) {
    const followedUpAt = g.timeline.findLast((t) => t.event === "follow_up_sent");
    const since = followedUpAt ? now.getTime() - new Date(followedUpAt.at).getTime() : Infinity;
    if (since < L2_DELAY_MS) return; // wait out the L2 window

    const rti = await draftRti(g);
    await grievances().update(g._id, {
      escalation_level: 2,
      status: "rti_drafted",
      rti_draft: rti,
      timeline: [...g.timeline, entry("rti_drafted", "RTI application auto-drafted — awaiting user review & submission")],
    });
    console.log(`[sla] ${g._id} escalated L1->L2 (RTI draft ready for user)`);
    return;
  }
}

export async function scanOnce(now = new Date()): Promise<number> {
  const breached = await grievances().findBreached(now);
  for (const g of breached) {
    try {
      await escalateOne(g, now);
    } catch (e) {
      console.error(`[sla] failed to escalate ${g._id}:`, e);
    }
  }
  return breached.length;
}

export function startSlaWorker() {
  const ms = config.slaScanIntervalSeconds * 1000;
  console.log(`[sla] escalation worker started (scan every ${config.slaScanIntervalSeconds}s, SLA=${config.slaHours}h)`);
  timer = setInterval(() => {
    scanOnce().catch((e) => console.error("[sla] scan error:", e));
  }, ms);
}

export function stopSlaWorker() {
  if (timer) clearInterval(timer);
}

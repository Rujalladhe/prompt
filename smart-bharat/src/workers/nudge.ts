import { listProfiles, profileToSlots } from "../memory/profile.js";
import { loadSchemes, matchSchemes, nextSlot } from "../agents/scheme.js";
import { addNotification, existingRefs } from "../memory/notifications.js";

/**
 * Proactive Nudge Agent (spec §2, background). NOT part of the live request graph
 * — a scheduled worker (BullMQ cron in production) that scans user profiles and
 * surfaces schemes they likely qualify for but haven't been told about. Renewal
 * reminders would hang off the same scan once we track document expiry dates.
 */

export async function runNudgeScan(): Promise<number> {
  const profiles = await listProfiles();
  const schemes = await loadSchemes();
  let created = 0;

  for (const p of profiles) {
    const slots = profileToSlots(p);
    // Only nudge if we know enough about the person to match meaningfully.
    if (nextSlot(slots)) continue; // profile too sparse
    const matches = matchSchemes(slots, schemes).slice(0, 3);
    // One dedup query per user (vs an existsFor() per match — the old N+1).
    const alreadyNudged = await existingRefs(p.user_id, "scheme_eligibility");
    for (const m of matches) {
      if (alreadyNudged.has(m.scheme.id)) continue;
      await addNotification({
        user_id: p.user_id,
        type: "scheme_eligibility",
        ref: m.scheme.id,
        title: `You may qualify for ${m.scheme.name}`,
        body: `${m.scheme.benefit}. ${m.reasons[0]}. Check: ${m.scheme.source_url}`,
      });
      created++;
    }
  }
  if (created) console.log(`[nudge] created ${created} proactive notification(s)`);
  return created;
}

let timer: NodeJS.Timeout | null = null;

export function startNudgeWorker(intervalSeconds = 60) {
  console.log(`[nudge] proactive nudge worker started (scan every ${intervalSeconds}s)`);
  timer = setInterval(() => runNudgeScan().catch((e) => console.error("[nudge] error:", e)), intervalSeconds * 1000);
}

export function stopNudgeWorker() {
  if (timer) clearInterval(timer);
}

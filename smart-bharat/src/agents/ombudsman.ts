import { generate } from "../llm.js";
import type { Grievance, RtiDraft } from "../schemas.js";
import { departmentLabel } from "../domain.js";

/**
 * Ombudsman escalation drafting. Two distinct, escalating artifacts:
 *  - L1 follow-up: a polite reminder to the department (auto-"sent" in the demo).
 *  - L2 RTI application: a legal document, pre-filled from the grievance
 *    timeline, SURFACED to the user for a one-click submit. It is NEVER
 *    auto-submitted — an RTI needs a human signature/click, always (spec §2.5).
 */

function timelineText(g: Grievance): string {
  return g.timeline.map((t) => `- ${t.at} [${t.actor}] ${t.event}${t.detail ? `: ${t.detail}` : ""}`).join("\n");
}

export async function draftFollowUp(g: Grievance): Promise<string> {
  return generate({
    task: "follow_up_letter",
    temperature: 0.3,
    system: `You draft short, polite, firm follow-up reminders to Indian government departments about pending civic complaints. Keep it under 120 words, formal register, no threats. Reference that the expected resolution time has elapsed.`,
    user: `Draft a follow-up reminder to the ${departmentLabel(g.department)}.
Complaint: ${g.title}
Category: ${g.category}, Severity: ${g.severity}
Filed: ${g.created_at}
SLA deadline (elapsed): ${g.sla_deadline}
Location: ${g.location_hint ?? "not specified"}
Summary: ${g.summary}`,
  });
}

export async function draftRti(g: Grievance): Promise<RtiDraft> {
  const authority = departmentLabel(g.department);
  const body = await generate({
    task: "rti_body",
    temperature: 0.2,
    system: `You draft applications under the Right to Information Act, 2005 for Indian citizens.
Write ONLY the application body. Ask specific, answerable questions about: the action taken on the complaint, names/designations of responsible officials, dates of any action, current status, and reasons for delay.
Formal, respectful. Do NOT invent facts; base questions on the provided timeline.`,
    user: `Public Authority: ${authority}
Complaint reference (internal): ${g._id}
Subject: ${g.title}
Filed on: ${g.created_at}
SLA deadline breached on: ${g.sla_deadline}
Complaint summary: ${g.summary}

Timeline so far:
${timelineText(g)}`,
  });

  return {
    drafted_at: new Date().toISOString(),
    public_authority: authority,
    subject: `RTI request regarding unresolved complaint: ${g.title}`,
    body,
    submitted_by_user: false,
  };
}

import { grievances } from "./db.js";
import { generate } from "./llm.js";
import { hasGroq } from "./config.js";

/**
 * Transparency dashboard (spec §9). Pure derived data from the grievance
 * collection — counts by department, SLA compliance, escalation funnel — plus an
 * auto-generated plain-language summary. Cheap to compute, strong demo visual.
 */

export interface Transparency {
  generated_at: string;
  total: number;
  by_status: Record<string, number>;
  by_department: { department: string; total: number; resolved: number; open: number }[];
  by_severity: Record<string, number>;
  sla: { within: number; breached: number; compliance_pct: number };
  escalations: { l1_follow_up: number; l2_rti: number };
  summary: string;
}

export async function computeTransparency(): Promise<Transparency> {
  const all = await grievances().list();
  const by_status: Record<string, number> = {};
  const by_severity: Record<string, number> = {};
  const deptMap = new Map<string, { total: number; resolved: number; open: number }>();
  let l1 = 0; // escalation_level >= 1 (a breach that reached at least an L1 follow-up)
  let l2 = 0; // escalation_level >= 2 (reached an RTI draft)

  // Single pass: everything below is accumulated in one loop over the collection.
  for (const g of all) {
    by_status[g.status] = (by_status[g.status] || 0) + 1;
    by_severity[g.severity] = (by_severity[g.severity] || 0) + 1;
    if (g.escalation_level >= 1) l1++;
    if (g.escalation_level >= 2) l2++;
    const d = deptMap.get(g.department) || { total: 0, resolved: 0, open: 0 };
    d.total++;
    if (g.status === "resolved") d.resolved++;
    else d.open++;
    deptMap.set(g.department, d);
  }

  const breached = l1; // a breached SLA is one escalated to L1 or beyond
  const within = all.length - breached;
  const compliance_pct = all.length ? Math.round((within / all.length) * 100) : 100;
  const escalations = { l1_follow_up: l1, l2_rti: l2 };
  const by_department = [...deptMap.entries()]
    .map(([department, v]) => ({ department, ...v }))
    .sort((a, b) => b.total - a.total);

  const stats = { total: all.length, compliance_pct, breached, ...escalations };
  let summary: string;
  if (all.length === 0) {
    summary = "No complaints filed yet.";
  } else if (!hasGroq()) {
    const top = by_department[0];
    summary = `${all.length} complaints tracked. ${compliance_pct}% resolved within SLA; ${breached} breached and were escalated (${escalations.l2_rti} reached an RTI draft). Busiest department: ${top.department.replace(/_/g, " ")} (${top.total}).`;
  } else {
    summary = (
      await generate({
        task: "transparency_summary",
        temperature: 0.3,
        system: "Write one plain-language sentence (like a civic scorecard) summarizing complaint resolution performance for citizens. No jargon.",
        user: `Stats: ${JSON.stringify(stats)}\nBy department: ${JSON.stringify(by_department)}`,
      })
    ).trim();
  }

  return {
    generated_at: new Date().toISOString(),
    total: all.length,
    by_status,
    by_department,
    by_severity,
    sla: { within, breached, compliance_pct },
    escalations,
    summary,
  };
}

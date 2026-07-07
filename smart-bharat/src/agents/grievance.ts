import { nanoid } from "nanoid";
import { structured } from "../llm.js";
import { grievances } from "../db.js";
import { config } from "../config.js";
import {
  GrievanceClassificationSchema,
  type Grievance,
  type GrievanceClassification,
  type TimelineEntry,
} from "../schemas.js";

const SYSTEM = `You are the Grievance Classification unit of an Indian civic platform.
Classify a citizen complaint into the correct government department and category, judge severity, and write a short neutral title and summary.
Severity guidance: high = danger to life/safety, major blockage, or affects many people; medium = clear inconvenience needing repair; low = minor/cosmetic.
Only use the allowed enum values. If a place or landmark is mentioned, capture it in location_hint, else null.`;

export async function classifyGrievance(text: string): Promise<GrievanceClassification> {
  return structured({
    task: "classify_grievance",
    schema: GrievanceClassificationSchema,
    system: SYSTEM,
    user: `Complaint from citizen:\n"""${text}"""`,
  });
}

/** Create + persist a grievance from a pre-computed classification. */
export async function createGrievance(input: {
  user_id: string;
  source: Grievance["source"];
  classification: GrievanceClassification;
  image_url?: string;
  rawText?: string;
}): Promise<Grievance> {
  const now = new Date();
  const deadline = new Date(now.getTime() + config.slaHours * 3600 * 1000);
  const c = input.classification;

  const timeline: TimelineEntry[] = [
    {
      at: now.toISOString(),
      actor: "user",
      event: "grievance_filed",
      detail: input.rawText ? input.rawText.slice(0, 200) : `via ${input.source}`,
    },
    {
      at: now.toISOString(),
      actor: "agent",
      event: "classified",
      detail: `${c.department} / ${c.category} / severity=${c.severity}`,
    },
  ];

  const g: Grievance = {
    _id: nanoid(12),
    user_id: input.user_id,
    source: input.source,
    department: c.department,
    category: c.category,
    severity: c.severity,
    title: c.title,
    summary: c.summary,
    location_hint: c.location_hint,
    status: "open",
    escalation_level: 0,
    created_at: now.toISOString(),
    sla_deadline: deadline.toISOString(),
    timeline,
    image_url: input.image_url,
  };
  return grievances().insert(g);
}

/** Convenience for the chat path: classify text then persist. */
export async function fileGrievanceFromText(user_id: string, text: string): Promise<Grievance> {
  const classification = await classifyGrievance(text);
  return createGrievance({ user_id, source: "chat", classification, rawText: text });
}

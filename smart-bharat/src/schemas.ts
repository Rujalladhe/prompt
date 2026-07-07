import { z } from "zod";

/**
 * Shared contracts. Every classification/routing decision in the system is a
 * schema-constrained LLM output, never free-text parsed with regex (spec §8).
 */

// ---- Orchestrator intent classification ----
export const IntentSchema = z.object({
  intent: z.enum([
    "query",
    "scheme_match",
    "document_help",
    "grievance_file",
    "grievance_status",
    "service_automation",
    "photo_complaint",
    "smalltalk",
  ]),
  language: z
    .string()
    .describe("BCP-ish tag for the language the USER wrote in, e.g. 'en', 'hi', 'hi-en' for Hinglish code-switch"),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe("one short sentence explaining the routing decision (for the trace)"),
});
export type Intent = z.infer<typeof IntentSchema>;

// ---- Grievance classification (Grievance/Ombudsman agent) ----
export const DEPARTMENTS = [
  "municipal_corporation",
  "public_works",
  "water_board",
  "electricity_board",
  "sanitation",
  "police",
  "transport",
  "health",
  "other",
] as const;

export const CATEGORIES = [
  "pothole",
  "garbage",
  "streetlight",
  "drainage",
  "water_supply",
  "power_cut",
  "road_damage",
  "public_safety",
  "other",
] as const;

export const GrievanceClassificationSchema = z.object({
  department: z.enum(DEPARTMENTS),
  category: z.enum(CATEGORIES),
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().describe("short title, max ~8 words"),
  summary: z.string().describe("2-3 sentence neutral summary of the complaint"),
  location_hint: z.string().nullable().describe("any place/landmark mentioned, else null"),
});
export type GrievanceClassification = z.infer<typeof GrievanceClassificationSchema>;

// ---- Photo-to-complaint vision output ----
export const PhotoClassificationSchema = z.object({
  is_civic_issue: z.boolean().describe("false if the image is not a real civic/public-infrastructure problem"),
  category: z.enum(CATEGORIES),
  severity: z.enum(["low", "medium", "high"]),
  severity_reason: z
    .string()
    .describe("cite the visual cues: size, blockage of path, standing water, exposed wires, etc."),
  description: z.string().describe("what is visible, plain language, one or two sentences"),
});
export type PhotoClassification = z.infer<typeof PhotoClassificationSchema>;

// ---- Persisted grievance document ----
export type EscalationLevel = 0 | 1 | 2;
export type GrievanceStatus = "open" | "follow_up_sent" | "rti_drafted" | "resolved" | "closed";

export interface Grievance {
  _id: string;
  user_id: string;
  source: "chat" | "photo";
  department: (typeof DEPARTMENTS)[number];
  category: (typeof CATEGORIES)[number];
  severity: "low" | "medium" | "high";
  title: string;
  summary: string;
  location_hint: string | null;
  status: GrievanceStatus;
  escalation_level: EscalationLevel;
  created_at: string; // ISO
  sla_deadline: string; // ISO
  timeline: TimelineEntry[];
  follow_up_draft?: string; // L1: auto-drafted, sent to dept (simulated)
  rti_draft?: RtiDraft; // L2: surfaced to user, NEVER auto-submitted
  image_url?: string;
}

export interface TimelineEntry {
  at: string; // ISO
  actor: "user" | "system" | "agent";
  event: string;
  detail?: string;
}

export interface RtiDraft {
  drafted_at: string;
  public_authority: string;
  subject: string;
  body: string;
  submitted_by_user: boolean;
}

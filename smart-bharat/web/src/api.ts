export const USER_ID = "citizen-1";
export const SESSION_ID = "sess-" + USER_ID;

export interface TraceStep { node: string; at: string; detail: string }
export interface Intent { intent: string; language: string; confidence: number; reason: string }
export interface Citation { n: number; title: string; source_url: string; snippet: string; published_date: string; stale: boolean }
export interface RtiDraft { drafted_at: string; public_authority: string; subject: string; body: string; submitted_by_user: boolean }
export interface Timeline { at: string; actor: string; event: string; detail?: string }
export interface Grievance {
  _id: string; title: string; department: string; category: string; severity: string;
  status: string; escalation_level: number; created_at: string; sla_deadline: string;
  summary: string; timeline: Timeline[]; follow_up_draft?: string; rti_draft?: RtiDraft;
  source: string; location_hint: string | null;
}
export interface ChatResult { reply: string; intent: Intent; grievanceId: string | null; citations: Citation[]; schemeActive: boolean; trace: TraceStep[] }
export interface VoiceChatResult extends ChatResult { audioBase64: string | null; audioContentType: string | null; voiceProvider: "elevenlabs" | "browser" }
export interface AutomationView {
  runId: string; service: string; status: "paused" | "done"; mode: "live" | "sim"; step_index: number; total_steps: number;
  interrupt: { reason?: string; instruction?: string; portal?: string } | null; screenshot: string;
  log: { index: number; type: string; detail: string; at: string; screenshot?: string }[];
}
export interface Transparency {
  generated_at: string; total: number; by_status: Record<string, number>;
  by_department: { department: string; total: number; resolved: number; open: number }[];
  by_severity: Record<string, number>; sla: { within: number; breached: number; compliance_pct: number };
  escalations: { l1_follow_up: number; l2_rti: number }; summary: string;
}
export interface Notification { _id: string; type: string; title: string; body: string; created_at: string; read: boolean }

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
const post = (url: string, body?: any) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

export const api = {
  health: () => fetch("/api/health").then(j<any>),
  chat: (message: string) => post("/api/chat", { userId: USER_ID, sessionId: SESSION_ID, message }).then(j<ChatResult>),
  voiceChat: (message: string) => post("/api/voice/chat", { userId: USER_ID, sessionId: "voice-" + USER_ID, message }).then(j<VoiceChatResult>),
  photo: (file: File, note: string) => {
    const fd = new FormData(); fd.append("image", file); fd.append("userId", USER_ID); fd.append("note", note);
    return fetch("/api/photo-complaint", { method: "POST", body: fd }).then(j<any>);
  },
  documentCheck: (file: File, serviceId: string) => {
    const fd = new FormData(); fd.append("image", file); fd.append("userId", USER_ID); fd.append("serviceId", serviceId);
    return fetch("/api/document-check", { method: "POST", body: fd }).then(j<any>);
  },
  services: () => fetch("/api/services").then(j<{ id: string; label: string; required_docs: string[] }[]>),
  grievances: () => fetch(`/api/grievances?userId=${USER_ID}`).then(j<Grievance[]>),
  fastForward: (id: string) => post(`/api/dev/fast-forward/${id}`).then(j<any>),
  submitRti: (id: string) => post(`/api/grievances/${id}/submit-rti`).then(j<Grievance>),
  transparency: () => fetch("/api/transparency").then(j<Transparency>),
  notifications: () => fetch(`/api/notifications?userId=${USER_ID}`).then(j<Notification[]>),
  nudgeScan: () => post("/api/nudge/scan").then(j<any>),
  automationServices: () => fetch("/api/automation/services").then(j<any[]>),
  automationStart: (serviceId: string) => post("/api/automation/start", { userId: USER_ID, serviceId }).then(j<AutomationView>),
  automationResume: (runId: string, note = "done") => post("/api/automation/resume", { runId, note }).then(j<AutomationView>),
  getProfile: () => fetch(`/api/profile?userId=${USER_ID}`).then(j<any>),
  putProfile: (patch: any) => fetch(`/api/profile?userId=${USER_ID}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(j<any>),
};

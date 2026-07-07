import { nanoid } from "nanoid";
import { mongoDbHandle } from "../db.js";

export interface Notification {
  _id: string;
  user_id: string;
  type: "scheme_eligibility" | "renewal" | "grievance_update";
  title: string;
  body: string;
  ref?: string; // scheme id / grievance id
  created_at: string;
  read: boolean;
}

// In-memory mode is indexed by user_id so reads/dedup are per-user, not full scans.
const mem = new Map<string, Notification[]>();
const col = () => mongoDbHandle()?.collection<Notification>("notifications") ?? null;

export async function addNotification(n: Omit<Notification, "_id" | "created_at" | "read">): Promise<Notification> {
  const full: Notification = { ...n, _id: nanoid(10), created_at: new Date().toISOString(), read: false };
  const c = col();
  if (c) await c.insertOne(full as any);
  else {
    const arr = mem.get(full.user_id) ?? [];
    arr.push(full);
    mem.set(full.user_id, arr);
  }
  return full;
}

export async function listNotifications(user_id: string): Promise<Notification[]> {
  const c = col();
  const all = c ? ((await c.find({ user_id }).toArray()) as Notification[]) : [...(mem.get(user_id) ?? [])];
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function existsFor(user_id: string, type: Notification["type"], ref: string): Promise<boolean> {
  const c = col();
  if (c) return !!(await c.findOne({ user_id, type, ref }));
  return (mem.get(user_id) ?? []).some((n) => n.type === type && n.ref === ref);
}

/**
 * All existing `ref`s of a type for a user, as a Set — one query instead of an N+1
 * of existsFor() calls (used by the nudge worker to dedup a batch of matches).
 */
export async function existingRefs(user_id: string, type: Notification["type"]): Promise<Set<string>> {
  const c = col();
  const rows = c
    ? ((await c.find({ user_id, type }, { projection: { ref: 1, _id: 0 } }).toArray()) as { ref?: string }[])
    : (mem.get(user_id) ?? []).filter((n) => n.type === type);
  return new Set(rows.map((n) => n.ref).filter((r): r is string => !!r));
}

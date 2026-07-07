import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { mongoDbHandle } from "./db.js";
import { config, isProd } from "./config.js";

/**
 * Self-contained auth (spec §7): scrypt password hashing + HS256 JWT, using only
 * node:crypto so there are no extra dependencies. Access tokens are short-lived;
 * a refresh-token rotation flow is the production add-on. RBAC roles:
 * citizen | official | admin.
 *
 * Identity is ALWAYS server-derived. A valid JWT's `sub` is authoritative and a
 * client-supplied userId is NEVER trusted for authorization — trusting it was a
 * broken-access-control hole letting any caller read/mutate another citizen's PII
 * by passing ?userId=victim (CLAUDE.md §2/§5). In "demo" AUTH_MODE an
 * unauthenticated request acts as a single fixed demo citizen so the flows work
 * out of the box; in "strict" mode user-scoped endpoints require a valid token.
 */

const DEMO_USER_ID = "citizen-1";

// The signing secret must be set explicitly in production; a known default would let
// anyone forge tokens. In development we fall back to a random per-process secret
// (tokens simply don't survive a restart, which is fine for local dev).
const SECRET = (() => {
  if (config.jwtSecret) return config.jwtSecret;
  if (isProd()) throw new Error("JWT_SECRET must be set in production (refusing to start with a default secret)");
  console.warn("[auth] JWT_SECRET not set — using an ephemeral random dev secret (tokens reset on restart)");
  return randomBytes(32).toString("hex");
})();
const b64u = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64uJson = (o: unknown) => b64u(JSON.stringify(o));

export type Role = "citizen" | "official" | "admin";
export interface User {
  user_id: string;
  email: string;
  pw_hash: string; // scrypt: salt:hash (hex)
  role: Role;
  created_at: string;
}

// ---- password hashing ----
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// ---- JWT (HS256) ----
export function signToken(payload: Record<string, unknown>, ttlSec = 900): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const data = `${b64uJson(header)}.${b64uJson(body)}`;
  const sig = b64u(createHmac("sha256", SECRET).update(data).digest());
  return `${data}.${sig}`;
}
export function verifyToken(token: string): (Record<string, any>) | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = b64u(createHmac("sha256", SECRET).update(`${h}.${p}`).digest());
  // Constant-time signature comparison (avoid a timing side-channel on the MAC).
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (body.exp && Math.floor(Date.now() / 1000) > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

// ---- user store (mongo | in-memory) ----
const mem = new Map<string, User>();
const col = () => mongoDbHandle()?.collection<User>("users") ?? null;

export async function findUser(email: string): Promise<User | null> {
  const c = col();
  if (c) return (await c.findOne({ email })) as User | null;
  return [...mem.values()].find((u) => u.email === email) ?? null;
}

export async function registerUser(email: string, pw: string, role: Role = "citizen"): Promise<User> {
  if (await findUser(email)) throw new Error("email already registered");
  const user: User = {
    user_id: "u_" + randomBytes(6).toString("hex"),
    email,
    pw_hash: hashPassword(pw),
    role,
    created_at: new Date().toISOString(),
  };
  const c = col();
  if (c) await c.insertOne(user as any);
  else mem.set(user.user_id, user);
  return user;
}

// ---- middleware ----
/**
 * Resolve the request's identity. A valid Bearer token is authoritative. When there
 * is no token: in "demo" mode we act as a single fixed demo citizen (so the flows
 * work with no login); in "strict" mode we set NO userId, and requireUser() below
 * will reject user-scoped endpoints. A client-supplied userId is deliberately
 * ignored — trusting it is the IDOR this replaces.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) {
    const claims = verifyToken(h.slice(7));
    if (claims) {
      (req as any).userId = claims.sub;
      (req as any).role = claims.role;
    }
  }
  if (!(req as any).userId && config.authMode !== "strict") {
    (req as any).userId = DEMO_USER_ID;
  }
  next();
}

/** 401 when there is no resolved user (only reachable in strict mode). */
export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).userId) return res.status(401).json({ error: "authentication required" });
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).role) return res.status(401).json({ error: "authentication required" });
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes((req as any).role)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

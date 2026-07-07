import { config, hasRecaptcha } from "../config.js";

/**
 * Google reCAPTCHA verification for auth endpoints (bot / credential-stuffing
 * defense, CLAUDE.md §5). Disabled unless RECAPTCHA_SECRET is set, so the demo
 * still registers/logs in with no token. When enabled, a missing/invalid token is
 * rejected. Fail-open ONLY on Google being unreachable, so an outage at Google
 * doesn't lock every citizen out of the service.
 */
export async function verifyRecaptcha(token: string | undefined, remoteIp?: string): Promise<boolean> {
  if (!hasRecaptcha()) return true; // feature off => allow (demo mode)
  if (!token) return false;
  try {
    const params = new URLSearchParams({ secret: config.recaptchaSecret, response: token });
    if (remoteIp) params.set("remoteip", remoteIp);
    const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) {
      console.warn(`[recaptcha] siteverify ${r.status} — failing open to avoid lockout`);
      return true;
    }
    const data: any = await r.json();
    return data.success === true;
  } catch (e: any) {
    console.warn(`[recaptcha] verify failed (${e?.message ?? e}) — failing open`);
    return true;
  }
}

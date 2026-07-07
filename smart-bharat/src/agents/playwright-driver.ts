import { config } from "../config.js";
import type { BrowserDriver } from "./browser-executor.js";

/**
 * Live Playwright implementation of BrowserDriver. Kept behind a DYNAMIC import so
 * the app still boots/typechecks when Playwright isn't installed — if the import or
 * browser launch fails, createPlaywrightDriver() returns null and the executor falls
 * back to the safe simulation (same graceful-degradation pattern as LLM/DB/voice).
 *
 * SAFETY (CLAUDE.md §2 #2): the browser is HEADFUL by default so the *user* types
 * their login/OTP straight into this window during the graph's interrupt() pauses.
 * This driver only ever navigate()s and fill()s non-secret profile fields; it never
 * touches passwords, OTPs, or the final submit button — those are human_required steps.
 */

export interface LiveDriver extends BrowserDriver {
  close(): Promise<void>;
}

export async function createPlaywrightDriver(): Promise<LiveDriver | null> {
  let chromium: any;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.warn("[browser] Playwright not installed — using simulation. Run: npm i playwright && npx playwright install chromium");
    return null;
  }
  try {
    const browser = await chromium.launch({ headless: config.browserHeadless });
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    const page = await context.newPage();

    return {
      async navigate(url: string) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      },

      async fill(selectorOrField: string, value: string) {
        // Try an explicit CSS selector first; otherwise heuristically locate the input
        // by common attributes (name/id/placeholder/aria-label/associated <label>).
        const candidates = looksLikeSelector(selectorOrField)
          ? [selectorOrField]
          : heuristicSelectors(selectorOrField);
        for (const sel of candidates) {
          try {
            const loc = sel.startsWith("label=") ? page.getByLabel(sel.slice(6), { exact: false }) : page.locator(sel);
            if (await loc.count()) {
              await loc.first().fill(value, { timeout: 3_000 });
              return;
            }
          } catch {
            /* try next candidate */
          }
        }
        // Field not present (e.g. gated behind a login the user hasn't done yet) — a
        // no-op is correct here, not an error. The step log will show 0 fields filled.
      },

      async screenshot() {
        const buf = await page.screenshot({ type: "png" });
        return "data:image/png;base64," + Buffer.from(buf).toString("base64");
      },

      async close() {
        await browser.close().catch(() => {});
      },
    };
  } catch (e: any) {
    console.warn(`[browser] Playwright launch failed (${e?.message ?? e}) — using simulation. Did you run: npx playwright install chromium ?`);
    return null;
  }
}

function looksLikeSelector(s: string): boolean {
  return /[#.\[\]=:>]/.test(s) || s.startsWith("label=");
}

/** Best-effort selectors for a logical field name like "address" or "name". */
function heuristicSelectors(field: string): string[] {
  const f = field.toLowerCase();
  return [
    `input[name="${field}"]`,
    `input[id="${field}"]`,
    `textarea[name="${field}"]`,
    `input[name*="${f}" i]`,
    `input[id*="${f}" i]`,
    `input[placeholder*="${f}" i]`,
    `input[aria-label*="${f}" i]`,
    `label=${field}`,
  ];
}

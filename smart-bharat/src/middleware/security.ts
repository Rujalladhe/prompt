import type { Request, Response, NextFunction } from "express";
import type { CorsOptions } from "cors";
import { config, isProd } from "../config.js";

/**
 * Baseline HTTP hardening (CLAUDE.md §5) without adding a helmet dependency: send
 * the standard defensive headers on every response and a strict CORS policy driven
 * by an explicit origin allowlist. This is a JSON API (the SPA is served separately),
 * so the CSP can be locked right down.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  // HSTS only makes sense over HTTPS (production behind TLS).
  if (isProd()) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

/**
 * CORS options from the CORS_ORIGINS allowlist. With an allowlist, only those
 * origins are permitted. Empty allowlist: reflect any origin in development (so the
 * Vite dev server / localhost just works) but DENY cross-origin browser calls in
 * production (fail closed rather than open).
 */
export function corsOptions(): CorsOptions {
  const allow = config.corsOrigins;
  return {
    credentials: true,
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser / same-origin (curl, server-to-server)
      if (allow.length === 0) return cb(null, !isProd()); // dev: reflect; prod: deny
      cb(null, allow.includes(origin.toLowerCase()));
    },
  };
}

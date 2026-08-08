import { TeamControlPlaneError } from "./controlPlane.js";
import { sanitizeSecretString } from "../security/secrets.js";

export const TEAM_CONTROL_PLANE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()"
});

/** Returns a fresh immutable header map for a future public transport. */
export function createTeamControlPlaneSecurityHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({ ...TEAM_CONTROL_PLANE_SECURITY_HEADERS });
}

export type TeamIdentity = { issuer: string; subject: string };
export interface TeamIdentityProvider {
  readonly kind: "disabled";
  authenticate(): Promise<TeamIdentity>;
}

/** A fail-closed placeholder until a concrete hosted deployment supplies OIDC configuration. */
export function createDisabledIdentityProvider(): TeamIdentityProvider {
  return {
    kind: "disabled",
    async authenticate(): Promise<TeamIdentity> {
      throw new TeamControlPlaneError("Enterprise identity provider is not configured.");
    }
  };
}

export type TeamRateLimitOptions = { limit?: number; windowMs?: number; maxKeys?: number; now?: () => Date };

/** Per-instance abuse guard for a future authenticated transport. Distributed deployments need a shared limiter. */
export class TeamControlPlaneRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => Date;
  private readonly entries = new Map<string, { startedAt: number; count: number }>();

  constructor(options: TeamRateLimitOptions = {}) {
    this.limit = options.limit ?? 60;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 10_000 || !Number.isInteger(this.windowMs) || this.windowMs < 1_000 || this.windowMs > 3_600_000 || !Number.isInteger(this.maxKeys) || this.maxKeys < 1 || this.maxKeys > 100_000) throw new TeamControlPlaneError("Rate limiter options are invalid.");
  }

  consume(key: string): { remaining: number; resetAt: string } {
    if (typeof key !== "string" || key.length < 1 || key.length > 128 || /[\u0000-\u001f]/.test(key) || sanitizeSecretString(key) !== key) throw new TeamControlPlaneError("Rate-limit key is invalid.");
    const timestamp = this.now().getTime();
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new TeamControlPlaneError("Rate-limit clock is invalid.");
    const current = this.entries.get(key);
    const entry = current === undefined || timestamp - current.startedAt >= this.windowMs ? { startedAt: timestamp, count: 0 } : current;
    if (current === undefined && this.entries.size >= this.maxKeys) this.prune(timestamp);
    if (current === undefined && this.entries.size >= this.maxKeys) throw new TeamControlPlaneError("Rate-limit key capacity exceeded.");
    entry.count += 1;
    this.entries.set(key, entry);
    const resetAt = new Date(entry.startedAt + this.windowMs).toISOString();
    if (entry.count > this.limit) throw new TeamControlPlaneError(`Rate limit exceeded. Retry after ${resetAt}.`);
    return { remaining: this.limit - entry.count, resetAt };
  }

  private prune(timestamp: number): void {
    for (const [key, entry] of this.entries) if (timestamp - entry.startedAt >= this.windowMs) this.entries.delete(key);
  }
}

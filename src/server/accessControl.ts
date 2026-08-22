import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { ServerConfig } from "../config/serverConfig.js";

const AUTH_COOKIE = "ghostapi_dashboard_token";
const MIN_TOKEN_LENGTH = 24;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function assertSafeDashboardConfig(config: ServerConfig): void {
  if (isLoopbackHost(config.host)) return;
  if (!config.authToken || config.authToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Remote bind ${config.host} requires GHOSTAPI_AUTH_TOKEN with at least ${MIN_TOKEN_LENGTH} characters.`);
  }
}

export function dashboardAccessControl(config: ServerConfig) {
  const remote = !isLoopbackHost(config.host);

  return (request: Request, response: Response, next: NextFunction): void => {
    const path = canonicalPath(request.path);
    const dashboardRoute = isDashboardPath(path);
    const protectedRoute = dashboardRoute || !isPublicRoute(path);
    if (!protectedRoute) {
      next();
      return;
    }

    const origin = request.header("origin");
    if (origin !== undefined && !isAllowedOrigin(origin, request, remote)) {
      response.status(403).json({ error: { code: "forbidden_origin", message: "GhostAPI protected routes only accept trusted origins." } });
      return;
    }

    if (!remote) {
      next();
      return;
    }

    const queryToken = typeof request.query.token === "string" ? request.query.token : undefined;
    if (request.method === "GET" && path === "/dashboard" && queryToken !== undefined && tokenMatches(queryToken, config.authToken)) {
      response.cookie(AUTH_COOKIE, queryToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: config.https === true,
        path: "/"
      });
      response.redirect(303, "/dashboard");
      return;
    }

    if (!tokenMatches(readRequestToken(request), config.authToken)) {
      response.setHeader("WWW-Authenticate", "Bearer realm=ghostapi-dashboard");
      response.status(401).json({ error: { code: "dashboard_auth_required", message: "Provide the configured GhostAPI dashboard token." } });
      return;
    }

    next();
  };
}

function isDashboardPath(path: string): boolean {
  return path === "/dashboard" || path.startsWith("/dashboard/") || path === "/events" || path === "/api" || path.startsWith("/api/");
}

function isPublicRoute(path: string): boolean {
  return path === "/" || path === "/health" || path === "/landing/assets" || path.startsWith("/landing/assets/");
}

function canonicalPath(path: string): string {
  const normalized = path.replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
  return normalized === "" ? "/" : normalized;
}

function isAllowedOrigin(origin: string, request: Request, remote: boolean): boolean {
  try {
    const parsed = new URL(origin);
    if (!remote) {
      const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return isLoopbackHost(parsed.hostname) && originPort === String(request.socket.localPort);
    }
    return parsed.host.toLowerCase() === request.get("host")?.toLowerCase();
  } catch {
    return false;
  }
}

function readRequestToken(request: Request): string | undefined {
  const authorization = request.header("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  const headerToken = request.header("x-ghostapi-token")?.trim();
  if (headerToken) return headerToken;
  const cookieHeader = request.header("cookie");
  if (!cookieHeader) return undefined;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...valueParts] = cookie.trim().split("=");
    if (name === AUTH_COOKIE) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

function tokenMatches(candidate: string | undefined, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

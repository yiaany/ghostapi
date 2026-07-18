import express, { type Express } from "express";
import { initializeCacheDir } from "../cache/index.js";
import { initializeStateStore } from "../state/stateStore.js";
import { registerRoutes } from "./routes.js";
import type { ServerConfig } from "../config/serverConfig.js";

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: string;
  }
}

function captureRawBody(request: express.Request, _response: express.Response, buffer: Buffer): void {
  if (buffer.length > 0) {
    request.rawBody = buffer.toString("utf8");
  }
}

export async function createServer(config: ServerConfig): Promise<Express> {
  await initializeStateStore();
  await initializeCacheDir();

  const app = express();

  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (req.path.startsWith("/api/") && origin !== undefined && !isLocalOrigin(origin)) {
      res.status(403).json({ error: { code: "forbidden_origin", message: "GhostAPI dashboard APIs only accept local origins." } });
      return;
    }

    res.header("Access-Control-Allow-Origin", origin && isLocalOrigin(origin) ? origin : "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Expose-Headers", "*");
    next();
  });

  app.use(express.json({ limit: "5mb", verify: captureRawBody }));
  app.use(express.urlencoded({ limit: "5mb", extended: true, verify: captureRawBody }));
  app.use(express.raw({ limit: "15mb", type: () => true, verify: captureRawBody }));

  registerRoutes(app, config);

  return app;
}

function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

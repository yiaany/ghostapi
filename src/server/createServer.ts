import express, { type Express } from "express";
import { initializeCacheDir } from "../cache/index.js";
import { initializeStateStore } from "../state/stateStore.js";
import { registerRoutes } from "./routes.js";
import type { ServerConfig } from "../config/serverConfig.js";
import {
  assertSafeDashboardConfig,
  dashboardAccessControl,
} from "./accessControl.js";
import { initializeFaultLab } from "../fault/faultLab.js";

export async function createServer(config: ServerConfig): Promise<Express> {
  assertSafeDashboardConfig(config);
  await initializeStateStore();
  await initializeCacheDir();
  await initializeFaultLab();

  const app = express();

  app.disable("x-powered-by");
  app.set("query parser", "simple");

  app.use(dashboardAccessControl(config));

  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ limit: "5mb", extended: true }));
  app.use(express.raw({ limit: "15mb", type: () => true }));

  registerRoutes(app, config);

  return app;
}

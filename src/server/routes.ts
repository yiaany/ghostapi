import type { Express, Request, Response, NextFunction } from "express";
import { proxyHandler } from "../proxy/proxyHandler.js";
import type { ServerConfig } from "../config/serverConfig.js";
import { addSseClient } from "./sse.js";
import { clearEvents, getEventsHistory } from "./eventsStore.js";
import { dashboardHandler, dashboardCssHandler, dashboardJsHandler } from "../dashboard/dashboard.js";
import { landingAssetsHandler, landingHandler } from "../landing/landing.js";
import { clearCache } from "../cache/index.js";
import { clearState } from "../state/stateStore.js";
import { getFaultLabConfig, updateFaultLabConfig } from "../fault/faultLab.js";
import { generateAiRules } from "../rules/aiRules.js";
import { generateRepoSetup } from "../setup/setupGenerator.js";
import { exportScenario, importScenario, listScenarioPresets, replayScenario, saveEventsAsScenario, shareScenario } from "../scenarios/scenarioStore.js";
import { generateAgentPrompt } from "../agents/agentPrompt.js";
import { generateVitestFromEvent } from "../tests/testGenerator.js";
import { generateSafetyReport } from "../report/safetyReport.js";

const PROXY_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const CLEAR_TARGETS = ["cache", "state", "events", "all"] as const;
type ClearTarget = typeof CLEAR_TARGETS[number];

export function registerRoutes(app: Express, config: ServerConfig): void {
  app.get("/", landingHandler);
  app.use("/landing/assets", landingAssetsHandler);

  app.get("/health", (_request: Request, response: Response) => {
    response.status(200).json({ ok: true });
  });

  app.get("/dashboard", dashboardHandler);
  app.get("/dashboard/styles.css", dashboardCssHandler);
  app.get("/dashboard/app.js", dashboardJsHandler);

  app.get("/events", (_request: Request, response: Response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    addSseClient(response);
  });

  app.get("/api/events", (_request: Request, response: Response) => {
    response.status(200).json(getEventsHistory());
  });

  app.get("/api/fault-lab", (_request: Request, response: Response) => {
    response.status(200).json(getFaultLabConfig());
  });

  app.post("/api/fault-lab", (req: Request, res: Response) => {
    try {
      res.status(200).json(updateFaultLabConfig(req.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Fault Lab config.";
      res.status(400).json({ error: { code: "invalid_fault_lab_config", message } });
    }
  });

  app.post("/api/ai-rules", async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await generateAiRules());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to generate AI rules.";
      res.status(500).json({ error: { code: "ai_rules_generation_failed", message } });
    }
  });

  app.post("/api/setup", async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await generateRepoSetup());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to generate repo setup.";
      res.status(500).json({ error: { code: "setup_generation_failed", message } });
    }
  });

  app.get("/api/scenarios", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await listScenarioPresets());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/scenarios", async (req: Request, res: Response) => {
    try {
      res.status(201).json(await importScenario(req.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to import scenario.";
      res.status(400).json({ error: { code: "invalid_scenario", message } });
    }
  });

  app.post("/api/scenarios/save-from-traffic", async (req: Request, res: Response) => {
    try {
      res.status(201).json(await saveEventsAsScenario(getEventsHistory(), req.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save traffic as scenario.";
      res.status(400).json({ error: { code: "scenario_save_failed", message } });
    }
  });

  app.post("/api/scenarios/:id/replay", async (req: Request, res: Response) => {
    try {
      res.status(200).json(await replayScenario(req.params.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to replay scenario.";
      res.status(404).json({ error: { code: "scenario_not_found", message } });
    }
  });

  app.get("/api/scenarios/:id/export", async (req: Request, res: Response) => {
    try {
      res.status(200).json(await exportScenario(req.params.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to export scenario.";
      res.status(404).json({ error: { code: "scenario_not_found", message } });
    }
  });

  app.post("/api/scenarios/:id/share", async (req: Request, res: Response) => {
    try {
      res.status(200).json(await shareScenario(req.params.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to share scenario.";
      res.status(404).json({ error: { code: "scenario_not_found", message } });
    }
  });

  app.post("/api/clear", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { target } = req.body;
      if (!isClearTarget(target)) {
        res.status(400).json({ error: { code: "invalid_clear_target", message: "Use target cache, state, events, or all." } });
        return;
      }
      if (target === "cache" || target === "all") await clearCache();
      if (target === "state" || target === "all") await clearState();
      if (target === "events" || target === "all") await clearEvents();
      res.status(200).json({ ok: true, cleared: target });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/agent-prompt", async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await generateAgentPrompt());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to generate agent prompt.";
      res.status(500).json({ error: { code: "agent_prompt_failed", message } });
    }
  });

  app.get("/api/events/:id/test", (req: Request, res: Response) => {
    const event = getEventsHistory().find((candidate) => candidate.id === req.params.id);
    if (event === undefined) {
      res.status(404).json({ error: { code: "event_not_found", message: "Event not found." } });
      return;
    }
    res.status(200).json(generateVitestFromEvent(event));
  });

  app.get("/api/safety-report", async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await generateSafetyReport());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to generate safety report.";
      res.status(500).json({ error: { code: "safety_report_failed", message } });
    }
  });

  for (const method of PROXY_METHODS) {
    if (method === "options") {
      app.options("*", (_req, res) => { res.sendStatus(204); });
      continue;
    }
    
    app[method]("*", async (req, res, next) => {
      try {
        await proxyHandler(req, res, config);
      } catch (error) {
        next(error);
      }
    });
  }

  // Global Error Handler guaranteeing JSON responses instead of crashing Express
  app.use((err: unknown, _req: Request, res: Response, _next: Function) => {
    const message = err instanceof Error ? err.message : "Unknown local proxy error";
    res.status(500).json({
      error: { code: "ghostapi_internal_error", message }
    });
  });
}

function isClearTarget(value: unknown): value is ClearTarget {
  return typeof value === "string" && CLEAR_TARGETS.includes(value as ClearTarget);
}

import type { Request, Response } from "express";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function dashboardHandler(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html");
  const html = await readFile(join(__dirname, "index.html"), "utf8");
  response.status(200).send(html);
}

export async function dashboardCssHandler(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/css");
  const css = await readFile(join(__dirname, "styles.css"), "utf8");
  response.status(200).send(css);
}

export async function dashboardJsHandler(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "application/javascript");
  const js = await readFile(join(__dirname, "app.js"), "utf8");
  response.status(200).send(js);
}
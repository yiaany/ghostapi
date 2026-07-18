import type { Request, Response } from "express";
import express from "express";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const landingAssetsHandler = express.static(join(__dirname, "assets"), { index: false });

export async function landingHandler(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html");
  const html = await readFile(join(__dirname, "index.html"), "utf8");
  response.status(200).send(html);
}

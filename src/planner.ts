import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./types.js";
import { Gemini } from "./gemini.js";

export interface PlanResult {
  stepsMdPath: string;
  markdown: string;
}

/**
 * Phase 1 — Gemini receives the PDF directly as multimodal input and returns
 * the steps.md markdown, which is persisted to the run directory.
 */
export async function plan(
  config: AppConfig,
  pdfPath: string,
  runId: string,
  runRoot: string,
): Promise<PlanResult> {
  const gemini = new Gemini(config);
  const markdown = await gemini.planFromPdf(pdfPath);
  await mkdir(runRoot, { recursive: true });
  const stepsMdPath = join(runRoot, "steps.md");
  await writeFile(stepsMdPath, markdown, "utf8");
  return { stepsMdPath, markdown };
}
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, RunState, RunStateStep, StepStatus } from "./types.js";
import { runDir } from "./paths.js";

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function createRunState(runId: string, labId: string, steps: RunStateStep[]): Promise<RunState> {
  const state: RunState = { labId, currentStep: 0, steps };
  await saveState(runId, state);
  return state;
}

export async function loadState(runId: string): Promise<RunState | null> {
  const file = join(runDir(runId), "state.json");
  if (!existsSync(file)) return null;
  const raw = JSON.parse(await readFile(file, "utf8"));
  return raw as RunState;
}

export async function saveState(runId: string, state: RunState): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

export function setStepStatus(state: RunState, index: number, status: StepStatus, screenshotPath?: string): void {
  const step = state.steps[index];
  if (!step) return;
  step.status = status;
  if (screenshotPath) step.screenshotPath = screenshotPath;
  state.currentStep = index + 1;
  if (status === "done" || status === "failed") {
    state.currentStep = index + 1;
  }
}

export function markRetry(state: RunState, index: number): number {
  const step = state.steps[index];
  step.retries += 1;
  return step.retries;
}

export function resetStepStatus(state: RunState, index: number, status: "pending" | "running"): void {
  state.steps[index].status = status;
}

export function buildManifest(state: RunState): Array<{ screenshotPath: string; command: string }> {
  return state.steps
    .filter((s) => s.screenshotPath)
    .map((s: RunStateStep) => ({ screenshotPath: s.screenshotPath!, command: s.command }));
}

export async function writeManifest(runId: string, entries: Array<{ screenshotPath: string; command: string }>): Promise<string> {
  const dir = runDir(runId);
  await ensureDir(dir);
  const file = join(dir, "manifest.json");
  await writeFile(file, JSON.stringify(entries, null, 2));
  return file;
}

export function isAllDone(state: RunState): boolean {
  return state.steps.length > 0 && state.steps.every((s) => s.status === "done");
}

export function isAllDoneOrFailed(state: RunState): boolean {
  return state.steps.length > 0 && state.steps.every((s) => s.status === "done" || s.status === "failed");
}

export function retryBudget(state: RunState, index: number, config: AppConfig): number {
  return Math.max(0, config.retryLimit - state.steps[index].retries);
}
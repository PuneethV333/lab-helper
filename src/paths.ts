import { readFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./types.js";

const CONFIG_DIR = join(os.homedir(), ".config", "lab-helper");
const TEMP_DIR = join(CONFIG_DIR, "temp");

export function configDir(): string {
  return CONFIG_DIR;
}

export function tempDir(): string {
  return TEMP_DIR;
}

export function runDir(runId: string): string {
  return join(TEMP_DIR, runId);
}

export const DEFAULT_RETRY_LIMIT = 5;

export function defaultConfig(): AppConfig {
  return { geminiApiKey: "", retryLimit: DEFAULT_RETRY_LIMIT, model: "gemini-2.5-flash" };
}

export function loadConfig(): AppConfig {
  const file = join(CONFIG_DIR, "config.json");
  if (!existsSync(file)) return defaultConfig();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>;
    return {
      ...defaultConfig(),
      ...raw,
      retryLimit: raw.retryLimit ?? DEFAULT_RETRY_LIMIT,
    };
  } catch {
    return defaultConfig();
  }
}

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
}

export function seedCreatePdfPy(): string {
  const dest = join(TEMP_DIR, "create-pdf.py");
  if (existsSync(dest)) return dest;
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, "..", "scripts", "create-pdf.py");
  if (!existsSync(src)) throw new Error(`scripts/create-pdf.py not found at ${src}`);
  ensureConfigDir();
  copyFileSync(src, dest);
  return dest;
}
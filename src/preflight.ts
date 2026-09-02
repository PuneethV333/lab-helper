import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./types.js";
import { configDir, DEFAULT_RETRY_LIMIT } from "./paths.js";
import { getEnvironment, resolveBinary, knownEnvironments, missingEnvironmentMessage } from "./environments/index.js";

export interface PreflightResult {
  ok: boolean;
  message?: string;
}

export function checkConfig(config: AppConfig): PreflightResult {
  const file = join(configDir(), "config.json");
  if (!existsSync(file)) {
    return {
      ok: false,
      message: `Config not found at ${file}. Create it with a "geminiApiKey" (and optional "retryLimit").`,
    };
  }
  if (!config.geminiApiKey) {
    return {
      ok: false,
      message: `${file} exists but has no "geminiApiKey". Add your Gemini API key to continue.`,
    };
  }
  if (typeof config.retryLimit !== "number" || config.retryLimit < 0) {
    return {
      ok: false,
      message: `"retryLimit" in ${file} must be a non-negative integer (default ${DEFAULT_RETRY_LIMIT}).`,
    };
  }
  return { ok: true };
}

function checkPython(): PreflightResult {
  try {
    execFileSync("python3", ["--version"], { stdio: "pipe" });
    return { ok: true };
  } catch {
    return { ok: false, message: "python3 is not on PATH. Install Python 3 to build the submission PDF." };
  }
}

export function checkReportLab(): PreflightResult {
  try {
    execFileSync("python3", ["-c", "import reportlab"], { stdio: "pipe" });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: 'reportlab is not importable by python3. Install it with: pip install reportlab (or python3 -m pip install reportlab).',
    };
  }
}

export function checkPlaywright(): PreflightResult {
  try {
    execFileSync("npx", ["playwright", "--version"], { stdio: "pipe" });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "playwright CLI is not available. Run: npm install playwright && npx playwright install chromium",
    };
  }
}

export function checkNodePty(): PreflightResult {
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node-pty") as { spawn: unknown };
    if (typeof mod.spawn === "function") return { ok: true };
    return { ok: false, message: "node-pty loaded but its native binding is incomplete." };
  } catch (e) {
    return { ok: false, message: `node-pty native binding could not load: ${(e as Error).message}` };
  }
}

export function checkChromiumInstalled(python3: string): PreflightResult {
  try {
    execFileSync(
      python3,
      [
        "-c",
        "from pathlib import Path; import json,glob,os; pats=glob.glob(os.path.expanduser('~/.cache/ms-playwright/*')); import sys; sys.exit(0 if any('chromium' in p for p in pats) else 1)",
      ],
      { stdio: "pipe" },
    );
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Playwright Chromium is not installed. Run: npx playwright install chromium",
    };
  }
}

export function globalPreflight(config: AppConfig): PreflightResult {
  const checks: Array<[string, () => PreflightResult]> = [
    ["config", () => checkConfig(config)],
    ["python3", checkPython],
    ["reportlab", checkReportLab],
    ["playwright", checkPlaywright],
    ["chromium", () => checkChromiumInstalled("python3")],
    ["node-pty", checkNodePty],
  ];
  for (const [name, check] of checks) {
    const result = check();
    if (!result.ok) {
      return { ok: false, message: `Preflight failed (${name}): ${result.message}` };
    }
  }
  return { ok: true };
}

export function environmentPreflight(environments: string[]): PreflightResult {
  for (const name of environments) {
    const env = getEnvironment(name);
    if (!env) return { ok: false, message: missingEnvironmentMessage(name) };
    const path = resolveBinary(env);
    if (!path) {
      const hint =
        name === "mysql"
          ? "Install MySQL (e.g. apt install mysql-client) or MariaDB."
          : name === "python"
            ? "Install Python 3."
            : name === "sqlite3"
              ? "Install sqlite3 (e.g. apt install sqlite3)."
              : `Install ${env.binary}.`;
      return {
        ok: false,
        message: `Environment "${name}" requires ${env.binary}, which is not on PATH. ${hint}`,
      };
    }
  }
  return { ok: true };
}

export { knownEnvironments };
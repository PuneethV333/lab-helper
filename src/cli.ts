#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, runDir, ensureConfigDir, configDir } from "./paths.js";
import type { AppConfig } from "./types.js";
import { globalPreflight } from "./preflight.js";
import { runPipeline, RunFailed } from "./pipeline.js";
import { HeadlessUi } from "./ui/headless.js";
import { Tui } from "./ui/tui.js";
import type { UiDriver } from "./ui/driver.js";

const USAGE = `
usage: lab-helper run <path-to-lab.pdf> [--output <dir>]

Runs the full pipeline (plan → execute → verify → assemble) and writes
<dir>/submission.pdf (default: current directory).
`.trim();

function parseArgv(argv: string[]): { cmd: string; pdf?: string; outputDir?: string } | { error: string } {
  const [cmd, rest] = [argv[0], argv.slice(1)];
  if (cmd !== "run") return { error: `Unknown command "${cmd ?? ""}"` };
  const pdf = rest.find((a) => !a.startsWith("--"));
  const outIdx = rest.indexOf("--output");
  const outputDir = outIdx >= 0 ? rest[outIdx + 1] : undefined;
  if (!pdf) return { error: "missing <path-to-lab.pdf>" };
  return { cmd, pdf, outputDir };
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`lab-helper: ${parsed.error}\n\n${USAGE}`);
    process.exit(2);
  }

  const pdfPath = resolve(parsed.pdf!);
  if (!existsSync(pdfPath)) {
    console.error(`lab-helper: PDF not found: ${pdfPath}\n\n${USAGE}`);
    process.exit(2);
  }
  const outputDir = parsed.outputDir ? resolve(parsed.outputDir) : process.cwd();

  ensureConfigDir();
  const config: AppConfig = loadConfig();
  const configFile = join(configDir(), "config.json");
  if (!existsSync(configFile)) {
    console.error(
      `lab-helper: config not found at ${configFile}\n\nCreate it as JSON:\n{\n  "geminiApiKey": "...",\n  "retryLimit": 5\n}`,
    );
    process.exit(2);
  }

  const headless = process.env.LAB_HELPER_HEADLESS === "1" || !process.stdout.isTTY;
  let cancelled = false;
  let ui: UiDriver;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void (async () => {
      await ui.destroy();
      console.error("\nlab-helper: cancelled");
      process.exit(130);
    })();
  };

  ui = headless ? new HeadlessUi(cancel) : new Tui({ onCancel: cancel });
  await ui.init(0);
  ui.setPhase("Phase 0 — Preflight");

  try {
    const preflight = globalPreflight(config);
    if (!preflight.ok) {
      ui.error(preflight.message!);
      await ui.destroy();
      process.exit(1);
    }
    ui.log("Preflight passed.");

    const ts = Date.now().toString(36);
    const runId = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const runRoot = runDir(runId);
    const outputPath = await runPipeline({
      config,
      pdfPath,
      outputDir,
      runId,
      runRoot,
      ui,
    });

    await ui.finish(`Done. Submission PDF: ${outputPath}`);
    process.exit(0);
  } catch (e) {
    if (!(e instanceof RunFailed)) {
      console.error(e);
    }
    ui.error(e instanceof Error ? e.message : String(e));
    await ui.destroy();
    process.exit(1);
  }
}

void main();
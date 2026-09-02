import { basename, join } from "node:path";
import type { AppConfig, RunState } from "./types.js";
import { Gemini } from "./gemini.js";
import { Executor } from "./executor.js";
import { ScreenRenderer } from "./renderer.js";
import { plan } from "./planner.js";
import { parseSteps, validateSteps } from "./parser.js";
import type { Step } from "./types.js";
import { environmentPreflight } from "./preflight.js";
import {
  buildManifest,
  createRunState,
  isAllDone,
  markRetry,
  saveState,
  setStepStatus,
  writeManifest,
} from "./state.js";
import { seedCreatePdfPy } from "./paths.js";
import { assemblePdf } from "./pdf.js";
import type { UiDriver } from "./ui/driver.js";

export class RunFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunFailed";
  }
}

interface PipelineOptions {
  config: AppConfig;
  pdfPath: string;
  outputDir: string;
  runId: string;
  runRoot: string;
  ui: UiDriver;
}

export async function runPipeline(opts: PipelineOptions): Promise<string> {
  const { config, pdfPath, outputDir, runId, runRoot, ui } = opts;
  const gemini = new Gemini(config);
  const labId = basename(pdfPath).replace(/\.pdf$/i, "") || "lab";

  // ---------- Phase 1 — Plan ----------
  ui.setPhase("Phase 1 — Plan");
  ui.setAction(`Reading ${basename(pdfPath)} and extracting lab steps…`);
  let markdown: string;
  try {
    markdown = (await plan(config, pdfPath, runId, runRoot)).markdown;
  } catch (e) {
    throw new RunFailed(`Step planning failed: ${(e as Error).message}`);
  }

  const parsed = parseSteps(markdown);
  if (parsed.error) throw new RunFailed(parsed.error);
  const validated = validateSteps(parsed.steps);
  if (validated.error) throw new RunFailed(validated.error);
  const steps: Step[] = validated.steps;
  ui.setAction(`Parsed ${steps.length} steps from the plan.`);

  // ---------- Phase 0 — environment checks ----------
  ui.setPhase("Phase 0 — Environment checks");
  const envs = [...new Set(steps.map((s) => s.environment))];
  for (const env of envs) ui.log(`checking ${env}`);
  const envCheck = environmentPreflight(envs);
  if (!envCheck.ok) throw new RunFailed(envCheck.message!);

  // ---------- state ----------
  const state: RunState = await createRunState(
    runId,
    labId,
    steps.map((s) => ({ id: s.id, command: s.command, environment: s.environment, status: "pending", retries: 0 })),
  );

  // ---------- Phase 2 — Execute ----------
  ui.setPhase("Phase 2 — Execute");
  const executor = new Executor({ onPrompt: (req) => ui.prompt(req) });
  const renderer = new ScreenRenderer();
  try {
    await renderer.init();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const budget = config.retryLimit;
      let attempts = 0;
      let phase: "command" | "screenshot" = "command";
      let lastResult = "";

      ui.setStepStatus(i, "running", step.command);
      while (true) {
        if (phase === "command") {
          ui.setAction(step.command);
          const result = await executor.runCommand(step.command, step.environment);
          lastResult = result.output;

          ui.setStepStatus(i, "verify_output", step.command);
          const v1 = await gemini.verifyText(step.expected, result.output);
          if (!v1.ok) {
            attempts += 1;
            markRetry(state, i);
            await saveState(runId, state);
            if (attempts > budget) {
              setStepStatus(state, i, "failed");
              await saveState(runId, state);
              throw new RunFailed(
                `Step ${i + 1} failed text verification after ${attempts} attempts.\n  Command: ${step.command}\n  Reason: ${v1.reason}\n  Output:\n${result.output.slice(0, 400)}`,
              );
            }
            ui.setStepStatus(i, "running", `retry ${attempts}/${budget} (text): ${v1.reason}`);
            ui.log(`  ✗ text verify failed (${attempts}/${budget}): ${v1.reason}`);
            phase = "command";
            continue;
          }
          ui.log(`  ✓ text verify passed`);
          phase = "screenshot";
          // fall through to capture
          continue;
        }

        // phase === "screenshot"
        const screenshotPath = join(runRoot, `step-${i + 1}-${attempts}.png`);
        await renderer.screenshot(step.command, lastResult, screenshotPath);
        ui.setStepStatus(i, "verify_screenshot", step.command);
        const v2 = await gemini.verifyVisionStep(step.expected, screenshotPath);
        if (!v2.ok) {
          attempts += 1;
          markRetry(state, i);
          await saveState(runId, state);
          if (attempts > budget) {
            setStepStatus(state, i, "failed");
            await saveState(runId, state);
            throw new RunFailed(
              `Step ${i + 1} failed screenshot verification after ${attempts} attempts.\n  Command: ${step.command}\n  Reason: ${v2.reason}`,
            );
          }
          ui.setStepStatus(i, "verify_output", `retry ${attempts}/${budget} (screenshot): ${v2.reason}`);
          ui.log(`  ✗ screenshot verify failed (${attempts}/${budget}): ${v2.reason}`);
          phase = "screenshot";
          continue;
        }
        setStepStatus(state, i, "done", screenshotPath);
        await saveState(runId, state);
        ui.setStepStatus(i, "done", screenshotPath);
        phase = "command";
        break;
      }
    }
  } catch (e) {
    if (e instanceof RunFailed) throw e;
    throw new RunFailed(`Step execution failed: ${(e as Error).message}`);
  } finally {
    executor.closeSession();
    await renderer.close();
  }

  // ---------- Phase 3 — Assemble ----------
  if (!isAllDone(state)) {
    throw new RunFailed("Run ended with incomplete steps; not assembling a PDF.");
  }
  ui.setPhase("Phase 3 — Assemble");
  const createPdfPy = seedCreatePdfPy();
  const manifest = buildManifest(state);
  await writeManifest(runId, manifest);
  const result = await assemblePdf(createPdfPy, runId, runRoot, manifest, outputDir);
  ui.log(`PDF written to ${result.outputPath}`);
  return result.outputPath;
}
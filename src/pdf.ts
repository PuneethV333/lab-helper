import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

export interface PdfResult {
  outputPath: string;
}

/**
 * Phase 3 — assemble the submission PDF from the ordered screenshot manifest.
 * create-pdf.py must be seeded into ~/.config/lab-helper/temp/ first.
 */
export async function assemblePdf(
  createPdfPy: string,
  runId: string,
  runRoot: string,
  manifest: Array<{ screenshotPath: string; command: string }>,
  outputDir: string,
): Promise<PdfResult> {
  const manifestPath = join(runRoot, "manifest.json");
  await writeManifestBytes(manifestPath, manifest);
  const tmpPdf = join(runRoot, "submission.pdf");
  const { stdout, stderr } = await execFileAsync("python3", [createPdfPy, "--manifest", manifestPath, "--output", tmpPdf], { encoding: "utf8" });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  if (!existsSync(tmpPdf)) {
    throw new Error(`create-pdf.py exited but produced no PDF at ${tmpPdf}`);
  }
  await copyFile(tmpPdf, join(outputDir, "submission.pdf"));
  return { outputPath: join(outputDir, "submission.pdf") };
}

async function writeManifestBytes(path: string, manifest: Array<{ screenshotPath: string; command: string }>): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2));
}
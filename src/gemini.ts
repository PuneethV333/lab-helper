import { GoogleGenAI, type Content } from "@google/genai";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AppConfig } from "./types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

export interface Verification {
  ok: boolean;
  reason: string;
}

export class Gemini {
  private ai: GoogleGenAI;
  private model: string;

  constructor(config: AppConfig) {
    this.ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    this.model = config.model ?? DEFAULT_MODEL;
  }

  /** Phase 1 — Gemini reads the lab PDF (multimodal) and returns steps.md markdown. */
  async planFromPdf(pdfPath: string): Promise<string> {
    const pdf = await readFile(pdfPath);
    const pdfName = basename(pdfPath);
    const prompt = [
      "You are a lab assistant that turns a lab-instruction PDF into a precise, executable step list.",
      "Extract every command the lab asks the student to run, IN ORDER. For each, determine the correct environment:",
      "- bash: any normal shell/terminal command",
      "- mysql: SQL statements run inside the MySQL client",
      "- sqlite3: SQL statements run inside the sqlite3 CLI",
      "- python: Python expressions/logic demonstrated in the Python REPL",
      "",
      "Produce ONLY a steps.md file with this EXACT structure, one '## Step' section per command:",
      "",
      "```markdown",
      "## Step 1",
      "**Environment:** bash",
      "**Command:**",
      "```bash",
      "<the command, exactly as the student should run it>",
      "```",
      "**Expected:**",
      "<what a correct result looks like, in plain language>",
      "",
      "## Step 2",
      "**Environment:** mysql",
      "**Command:**",
      "```sql",
      "...",
      "```",
      "**Expected:**",
      "<...>",
      "```",
      "",
      "Rules:",
      "- Never invent setup steps (creating databases/users in mysql) that the PDF itself does not ask for.",
      "- Keep commands exactly as stated in the PDF; never paraphrase them.",
      "- The 'Expected' description should be concrete enough that another agent can verify the output.",
      "- Include every step. If the PDF has numbered procedures (A/B/C...), follow that numbering.",
      "",
      `Lab PDF: ${pdfName}`,
    ].join("\n");

    const parts: Content[] = [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } },
        ],
      },
    ];
    const res = await this.ai.models.generateContent({ model: this.model, contents: parts });
    const text = res.text;
    if (!text) throw new Error("Gemini returned no plan for the PDF.");
    return text;
  }

  /** Verify #1 — text: does captured command output match the expected result? */
  async verifyText(expected: string, output: string): Promise<Verification> {
    const prompt = [
      "You verify whether a command's captured terminal output matches its expected result.",
      "",
      `EXPECTED RESULT:\n${expected}`,
      "",
      `CAPTURED OUTPUT:\n${output || "(no output)"}`,
      "",
      'Respond ONLY with JSON: {"ok": true/false, "reason": "one short sentence explaining why."}',
    ].join("\n");

    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    return this.decodeVerification(res.text);
  }

  /** Verify #2 — vision: does the screenshot itself show the expected result? */
  async verifyVisionStep(expected: string, screenshotPath: string): Promise<Verification> {
    const image = await readFile(screenshotPath);
    const prompt = [
      "You verify whether a terminal screenshot shows the expected result of a lab step.",
      "",
      `EXPECTED RESULT:\n${expected}`,
      "",
      "Look at the screenshot. Check the visible command output matches the expected result.",
      'Respond ONLY with JSON: {"ok": true/false, "reason": "one short sentence explaining why."}',
    ].join("\n");

    const parts = [
      { text: prompt },
      { inlineData: { mimeType: "image/png", data: image.toString("base64") } },
    ];
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: parts,
      config: { responseMimeType: "application/json" },
    });
    return this.decodeVerification(res.text);
  }

  private decodeVerification(text: string | undefined): Verification {
    if (!text) return { ok: false, reason: "Gemini returned an empty verification." };
    try {
      const parsed = JSON.parse(text) as { ok?: boolean; reason?: string };
      return { ok: Boolean(parsed.ok), reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given" };
    } catch {
      // Sometimes the model wraps JSON in ```json fences.
      const m = /\{[\s\S]*"ok"\s*:\s*(true|false)[\s\S]*\}/.exec(text);
      if (m) {
        return { ok: m[1] === "true", reason: "parsed from fenced JSON" };
      }
      return { ok: false, reason: "Gemini verification could not be decoded." };
    }
  }
}
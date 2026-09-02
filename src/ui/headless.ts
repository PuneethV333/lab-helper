import { createInterface, type Interface } from "node:readline";
import type { PromptRequest } from "../types.js";
import type { UiDriver } from "./driver.js";

const AUTO_ANSWERS = (process.env.LAB_HELPER_PROMPT_ANSWERS ?? "").split(",").filter(Boolean);

/**
 * Plain logging UI for non-TTY / test runs. Interactive prompts read a line
 * from stdin (or the LAB_HELPER_PROMPT_ANSWERS dev/test override).
 */
export class HeadlessUi implements UiDriver {
  private readline: Interface | null = null;
  private promptIndex = 0;
  private readonly onCancel: () => void;

  constructor(onCancel?: () => void) {
    this.onCancel = onCancel ?? (() => undefined);
  }

  async init(_totalSteps: number): Promise<void> {
    this.readline = createInterface({ input: process.stdin, terminal: false });
    process.stdin.on("keypress", () => undefined);
    void this.onCancel;
    return undefined;
  }

  setStepCount(_totalSteps: number): void {}

  setPhase(text: string): void {
    console.log(`[phase] ${text}`);
  }

  setAction(text: string): void {
    console.log(`  → ${text}`);
  }

  setStepStatus(index: number, status: string, detail?: string): void {
    console.log(`  [step ${index + 1}] ${status}${detail ? `: ${detail}` : ""}`);
  }

  log(line: string): void {
    console.log(`  ${line}`);
  }

  error(line: string): void {
    console.error(`  ✗ ${line}`);
  }

  async prompt(request: PromptRequest): Promise<string> {
    if (this.promptIndex < AUTO_ANSWERS.length) {
      const value = AUTO_ANSWERS[this.promptIndex++];
      console.log(`  prompt(${request.label}) -> [autofilled]`);
      return value;
    }
    if (!this.readline) throw new Error("prompt called before init");
    console.log(`  prompt(${request.label}):`);
    return new Promise((resolve) => {
      this.readline!.question("  > ", (line: string) => resolve(line.trim()));
    });
  }

  async finish(message: string): Promise<void> {
    console.log(message);
    this.readline?.close();
    return undefined;
  }

  async destroy(): Promise<void> {
    this.readline?.close();
    this.readline = null;
    return undefined;
  }
}
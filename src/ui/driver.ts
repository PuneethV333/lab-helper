import type { PromptRequest } from "../types.js";

export interface UiDriver {
  init(totalSteps: number): Promise<void>;
  setStepCount(totalSteps: number): void;
  setPhase(text: string): void;
  setAction(text: string): void;
  setStepStatus(index: number, status: string, detail?: string): void;
  log(line: string): void;
  error(line: string): void;
  prompt(request: PromptRequest): Promise<string>;
  finish(message: string): Promise<void>;
  destroy(): Promise<void>;
}

export const STATUS_COLORS: Record<string, string> = {
  pending: "#565f89",
  running: "#7aa2f7",
  verify_output: "#e0af68",
  verify_screenshot: "#e0af68",
  done: "#9ece6a",
  failed: "#f7768e",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  running: "running",
  verify_output: "verify",
  verify_screenshot: "screenshot",
  done: "done",
  failed: "failed",
};
export interface Step {
  id: number;
  /** Original step identifier from the plan (e.g. "1", "A1", "3b"). */
  rawId?: string;
  command: string;
  environment: string;
  expected: string;
}

export type StepStatus =
  | "pending"
  | "running"
  | "verify_output"
  | "verify_screenshot"
  | "done"
  | "failed";

export interface RunStateStep {
  id: number;
  command: string;
  environment: string;
  status: StepStatus;
  retries: number;
  screenshotPath?: string;
}

export interface RunState {
  labId: string;
  currentStep: number;
  steps: RunStateStep[];
}

export interface AppConfig {
  geminiApiKey: string;
  retryLimit: number;
  model?: string;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  done: boolean;
}

export interface PromptDescriptor {
  pattern: RegExp;
  label: string;
  secret: boolean;
}

export interface EnvironmentDef {
  name: string;
  binary: string;
  healthCheck: string;
  spawnCommand: string;
  spawnArgs?: string[];
  isDone: (buffer: string) => boolean;
  prompts: PromptDescriptor[];
}

export interface PromptRequest {
  label: string;
  secret: boolean;
}
import * as pty from "node-pty";
import { spawn } from "node:child_process";
import type { CommandResult, EnvironmentDef, PromptRequest } from "./types.js";
import { getEnvironment } from "./environments/index.js";

export interface ExecutorOptions {
  idleTimeoutMs?: number;
  onPrompt: (request: PromptRequest) => Promise<string>;
}

interface ReplSession {
  env: EnvironmentDef;
  proc: pty.IPty;
  buffer: string;
  exited: boolean;
  exitCode: number | null;
  firstCommand: boolean;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OTHER_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function sanitize(raw: string): string {
  return raw
    .replace(ANSI_RE, "")
    .replace(OTHER_CONTROL_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write a user's answer to the PTY, submitting it with Enter. */
function writeAnswer(proc: pty.IPty, value: string): void {
  proc.write(/\r$|\n$/.test(value) ? value : `${value}\r`);
}

export class Executor {
  private repl: ReplSession | null = null;
  private readonly idleTimeoutMs: number;
  private readonly onPrompt: (request: PromptRequest) => Promise<string>;

  constructor(options: ExecutorOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 8000;
    this.onPrompt = options.onPrompt;
  }

  private spawnRepl(env: EnvironmentDef): ReplSession {
    const proc = pty.spawn(env.spawnCommand, [...(env.spawnArgs ?? [])], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env as Record<string, string>, TERM: "xterm-256color" },
    });
    const session: ReplSession = { env, proc, buffer: "", exited: false, exitCode: null, firstCommand: true };
    proc.onData((data) => {
      session.buffer += data;
    });
    proc.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
    });
    return session;
  }

  currentEnvironment(): string | null {
    return this.repl?.env.name ?? null;
  }

  private async ensureRepl(env: EnvironmentDef): Promise<ReplSession> {
    if (this.repl && this.repl.env.name === env.name && !this.repl.exited) return this.repl;
    this.closeSession();
    this.repl = this.spawnRepl(env);
    await this.settleInitialPrompts(this.repl);
    return this.repl;
  }

  /**
   * Resolve initial interactive prompts (e.g. mysql's "Enter password:")
   * present at spawn time, and wait until the REPL shows a ready prompt.
   */
  private async settleInitialPrompts(session: ReplSession): Promise<void> {
    const deadline = Date.now() + 15000;
    const answered = new Set<string>();
    while (Date.now() < deadline) {
      if (session.exited) return;
      const clean = sanitize(session.buffer);
      let answeredAny = false;
      for (const prompt of session.env.prompts) {
        if (prompt.pattern.test(clean) && !answered.has(prompt.pattern.source)) {
          answered.add(prompt.pattern.source);
          const value = await this.onPrompt({ label: prompt.label, secret: prompt.secret });
          writeAnswer(session.proc, value);
          answeredAny = true;
          break;
        }
      }
      if (!answeredAny && session.env.isDone(clean)) return;
      await wait(150);
    }
  }

  private async runReplCommand(session: ReplSession, command: string): Promise<CommandResult> {
    const startLen = sanitize(session.buffer).length;
    session.proc.write(`${command}\r`);
    let lastActivity = Date.now();
    let lastLen = startLen;
    const answered = new Set<string>();

    while (true) {
      if (session.exited) {
        return { exitCode: session.exitCode, output: sanitize(session.buffer), done: true };
      }
      const clean = sanitize(session.buffer);
      // Prompt detection only considers output produced by the current
      // command — stale prompts in the pre-existing buffer must not re-fire.
      const newOutput = clean.slice(startLen);
      const grown = clean.length > startLen;

      let prompted = false;
      for (const prompt of session.env.prompts) {
        if (prompt.pattern.test(newOutput) && !answered.has(prompt.pattern.source)) {
          answered.add(prompt.pattern.source);
          const value = await this.onPrompt({ label: prompt.label, secret: prompt.secret });
          writeAnswer(session.proc, value);
          prompted = true;
          lastActivity = Date.now();
          break;
        }
      }
      if (prompted) continue;

      if (grown && session.env.isDone(clean)) {
        return { exitCode: null, output: clean.trimEnd(), done: true };
      }

      if (clean.length !== lastLen) {
        lastLen = clean.length;
        lastActivity = Date.now();
      }
      if (Date.now() - lastActivity > this.idleTimeoutMs) {
        const value = await this.onPrompt({
          label: "This command appears to be waiting for input (idle timeout)",
          secret: false,
        });
        writeAnswer(session.proc, value);
        lastActivity = Date.now();
      }
      await wait(100);
    }
  }

  private async runBash(command: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      // One-shot commands are self-contained per the plan format; no stdin.
      // (Interactive input is a REPL concern handled via the PTY session.)
      const child = spawn("bash", ["-lc", command], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env as Record<string, string>, TERM: "xterm-256color", FORCE_COLOR: "1" },
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (output += d.toString()));
      child.on("error", (err) => {
        resolve({ exitCode: 127, output: sanitize(`command failed to start: ${err.message}`), done: true });
      });
      child.on("close", (code) => {
        resolve({ exitCode: code, output: sanitize(output).trimEnd(), done: true });
      });
    });
  }

  async runCommand(command: string, environment: string): Promise<CommandResult> {
    if (environment === "bash") return this.runBash(command);
    const env = getEnvironment(environment);
    if (!env) throw new Error(`Unknown environment "${environment}"`);
    const session = await this.ensureRepl(env);
    return this.runReplCommand(session, command);
  }

  lastOutput(): string {
    return this.repl ? sanitize(this.repl.buffer) : "";
  }

  closeSession(): void {
    if (this.repl) {
      try {
        this.repl.proc.kill();
      } catch {
        /* already dead */
      }
      this.repl = null;
    }
  }
}
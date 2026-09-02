import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core";
import type { PromptRequest } from "../types.js";
import { STATUS_COLORS, STATUS_LABEL, type UiDriver } from "./driver.js";

interface TuiOptions {
  onCancel?: () => void;
  title?: string;
}

const PRINTABLE = /^[^\x00-\x1f\x7f]$/;

/**
 * OpenTUI progress UI (imperative Core API). Takes over the terminal with an
 * alternate screen; call destroy() to restore it.
 */
export class Tui implements UiDriver {
  private renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;
  private header!: TextRenderable;
  private phase!: TextRenderable;
  private action!: TextRenderable;
  private stepLines: TextRenderable[] = [];
  private stepsBox!: BoxRenderable;
  private logBox!: TextRenderable;
  private promptLine!: TextRenderable;
  private logLines: string[] = [];
  private onCancel: () => void;

  constructor(options: TuiOptions = {}) {
    this.onCancel = options.onCancel ?? (() => undefined);
  }

  async init(totalSteps: number): Promise<void> {
    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    this.renderer = renderer;

    const root = renderer.root;
    this.header = new TextRenderable(renderer, { content: "lab-helper", fg: "#7aa2f7" });
    this.phase = new TextRenderable(renderer, { content: "Phase 0 — Preflight", fg: "#c0caf5" });
    this.action = new TextRenderable(renderer, { content: "", fg: "#e0af68" });

    const stepsBox = new BoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 0,
      overflow: "hidden",
      flexDirection: "column",
    });
    this.stepsBox = stepsBox;
    for (let i = 0; i < totalSteps; i++) {
      this.addStepLine(i);
    }

    this.logBox = new TextRenderable(renderer, { content: "", fg: "#565f89" });
    this.promptLine = new TextRenderable(renderer, { content: "", fg: "#9ece6a" });

    root.add(this.header);
    root.add(this.phase);
    root.add(this.action);
    root.add(stepsBox);
    root.add(this.logBox);
    root.add(this.promptLine);

    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c") {
        this.onCancel();
      }
    });

    for (let i = 0; i < totalSteps; i++) this.setStepStatus(i, "pending");
  }

  setPhase(text: string): void {
    this.phase.content = text;
  }

  setStepCount(totalSteps: number): void {
    while (this.stepLines.length < totalSteps) this.addStepLine(this.stepLines.length);
  }

  private addStepLine(index: number): void {
    if (!this.renderer) return;
    const line = new TextRenderable(this.renderer, { content: "", fg: STATUS_COLORS.pending });
    this.stepsBox.add(line);
    this.stepLines.push(line);
    line.content = `[${STATUS_LABEL.pending.padEnd(9)}]  Step ${index + 1}`;
  }

  setAction(text: string): void {
    this.action.content = text;
  }

  setStepStatus(index: number, status: string, detail?: string): void {
    const line = this.stepLines[index];
    if (!line) return;
    const label = STATUS_LABEL[status] ?? status;
    const color = STATUS_COLORS[status] ?? "#c0caf5";
    line.content = `[${label.padEnd(9)}]  Step ${index + 1}${detail ? `  ${detail}` : ""}`;
    line.fg = color;
  }

  log(line: string): void {
    this.logLines.push(line);
    while (this.logLines.length > 10) this.logLines.shift();
    this.logBox.content = this.logLines.join("\n");
  }

  error(line: string): void {
    this.log(line);
    this.action.content = `✗ ${line}`;
    this.action.fg = "#f7768e";
  }

  async prompt(request: PromptRequest): Promise<string> {
    const renderer = this.renderer;
    if (!renderer) throw new Error("TUI not initialized");
    let buf = "";
    this.promptLine.fg = "#9ece6a";
    const paint = (): void => {
      const shown = request.secret ? "*".repeat(buf.length) : buf;
      this.promptLine.content = `${request.label}: ${shown}_`;
      this.log(`${request.label}: ${shown}`);
    };
    paint();
    return new Promise((resolve) => {
      const onKey = (key: { name: string; sequence: string; ctrl?: boolean; meta?: boolean; alt?: boolean }): void => {
        if (key.ctrl && key.name === "c") {
          renderer.keyInput.off("keypress", onKey);
          this.promptLine.content = "";
          this.onCancel();
          resolve("");
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          renderer.keyInput.off("keypress", onKey);
          this.promptLine.content = "";
          resolve(buf);
          return;
        }
        if (key.name === "escape") {
          renderer.keyInput.off("keypress", onKey);
          this.promptLine.content = "";
          resolve(buf);
          return;
        }
        if (key.name === "backspace") {
          buf = buf.slice(0, -1);
          paint();
          return;
        }
        if (key.ctrl || key.meta || key.alt) return;
        if (PRINTABLE.test(key.sequence)) {
          buf += key.sequence;
          paint();
        }
      };
      renderer.keyInput.on("keypress", onKey);
    });
  }

  async finish(message: string): Promise<void> {
    if (!this.renderer) return;
    this.action.content = message;
    this.action.fg = "#9ece6a";
    this.renderer.destroy();
    this.renderer = null;
    console.log(message);
  }

  async destroy(): Promise<void> {
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }
}
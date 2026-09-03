# lab-helper

Automates PESU lab submissions. Give it a lab-instruction PDF; it reads the required steps, executes every command in the right environment (bash, MySQL, Python, sqlite3 REPLs), verifies each result twice (text + vision), captures a clean terminal screenshot, and compiles everything into a submission PDF you can hand in.

It replaces the manual loop: read PDF → run command → screenshot → paste into doc → repeat ×40.

Works across lab subjects — DBMS, OS, networking, scripting — anything whose deliverable is a terminal screenshot. It is **not** a general-purpose agent: browser/GUI labs and concurrent client–server programs are out of scope.

## Install

```sh
curl -fsSL <release-url>/install.sh | sh
```

The installer checks Node 18+ and Python 3, installs `lab-helper` globally via npm, installs `reportlab` for Python (with a venv fallback for PEP 668 environments), pre-fetches Playwright's Chromium, and scaffolds the config directory.

## Usage

```sh
lab-helper run <path-to-lab.pdf> [--output <dir>]
```

On success, `submission.pdf` lands in `<output-dir>` (default: current directory). Progress renders live in the terminal (OpenTUI); on non-TTY or test runs a plain-logging UI is used.

Any unrecoverable failure — a step exceeding its retry budget, a missing preflight binary, malformed plan output — halts the entire run immediately. There is no skip-and-continue: a broken step means the run stops so it can be inspected, not silently produces an incomplete submission.

## Config

`~/.config/lab-helper/config.json`:

```json
{
  "geminiApiKey": "...",
  "retryLimit": 5
}
```

- `geminiApiKey` — Google Gemini API key (required). Create one at https://aistudio.google.com/apikey
- `retryLimit` — max retries per step, combined across both verification passes (default 5)

> **Note:** the Gemini API key is stored in plaintext on disk. This is acceptable for a personal/local tool, but don't copy this pattern into anything shared or hosted without real secret handling.

## How it works

One model (Gemini), four phases:

```
PDF ──▶ Preflight ──▶ Plan ──▶ Execute ──▶ Assemble ──▶ submission.pdf
       (two-stage)   (1 call)  (per-step)   (ReportLab)
```

### Phase 0 — Preflight

Runs automatically on every invocation and halts before touching anything if it fails. Two stages, because environment checks depend on what the plan needs:

1. **Global checks** (before planning): config file with an API key present, `python3` on PATH, `reportlab` importable, Playwright Chromium installed (auto-installed if missing — safe to self-heal), `node-pty` native binding loads.
2. **Environment checks** (after planning): every `environment` referenced in the extracted plan must be registered *and* its binary must exist (e.g. `mysql --version` for the `mysql` environment). A missing tool halts with the exact binary name and an install hint — never a mid-run failure.

### Phase 1 — Plan

The PDF is sent to Gemini directly as multimodal input (no separate PDF reader). The model returns a `steps.md` plan:

```markdown
## Step 1
**Environment:** mysql
**Command:**
```sql
CREATE DATABASE lab1;
```
**Expected:**
MySQL responds "Database changed" or "Query OK"...
```

Every command is kept verbatim from the PDF — the planner is told to never invent or paraphrase steps. `steps.md` is parsed with `remark` into a structured step list and validated with **Zod** immediately, so malformed plan output halts the run before any command executes.

### Phase 2 — Execute

Each step, in order:

1. **`run_command(command, environment)`** — executed through the environment registry via `node-pty`.
2. **Verify #1 (text)** — Gemini checks the captured terminal output against the step's expected description.
3. **Screenshot** — rendered via `xterm.js` inside one persistent Playwright page (browser launched once for the whole run). Only callable after `run_command` resolves `done: true` — this is the race-condition fix for the screenshots-before-finish problem.
4. **Verify #2 (vision)** — Gemini checks the screenshot image itself matches the expected result, catching render/capture glitches the text check can't see.

**Failures:** a verify #1 failure retries the command; a verify #2 failure retries only the screenshot capture (a stateful command is never re-run just because its screenshot came out wrong). Retries are tracked per step in `state.json` and capped at `retryLimit` (default 5) combined across both passes — exceeding it halts the run with a clear error.

**Session persistence:** consecutive steps in the same environment reuse one open REPL session, so a `USE lab1;` step sees the `CREATE DATABASE lab1;` from the previous step in the *same* session. Sessions are respawned only on first use or when the environment changes.

**Interactive prompts:** if a command prompts for input mid-run (e.g. `mysql -u root -p` asking for a password), the executor intercepts it — the UI asks the user (masked when the prompt is marked secret), writes the answer to the PTY, and execution resumes. A generic fallback covers prompts nobody registered: if PTY output goes idle (default 8s) without the process exiting, the UI surfaces "this command appears to be waiting for input" and lets the user type a response instead of hanging forever.

**Run state** lives in `state.json` (per-run temp directory), not in the model's conversation history. This bounds context size regardless of run length and makes the run resumable in principle.

### Phase 3 — Assemble

Once every step is `done`, the harness builds a JSON manifest of ordered `{ screenshotPath, command }` entries and invokes `scripts/create-pdf.py` (Python + ReportLab): one page per screenshot, captioned with the step's command. The finished PDF is moved to the output directory; a non-zero exit or missing file halts the run like any other failure.

## Architecture

```
src/
├── cli.ts              # argument parsing, run orchestration
├── preflight.ts        # Phase 0 — global + per-environment checks, chromium self-heal
├── planner.ts          # Phase 1 — Gemini(PDF) -> steps.md
├── parser.ts           # steps.md -> Step[] (remark + zod validation)
├── environments/
│   └── index.ts        # registry: bash, mysql, python, sqlite3 — each entry
│                       #   declares spawn cmd, done-regex, known prompts
├── executor.ts         # node-pty run_command, completion detection,
│                       #   session reuse, prompt interception, idle fallback
├── renderer.ts         # xterm.js in a persistent Playwright page -> PNG
├── gemini.ts           # Gemini client: plan from PDF, verify text, verify vision
├── pdf.ts              # invokes create-pdf.py, moves result to output dir
├── state.ts            # state.json read/write; retry + status tracking
├── pipeline.ts         # wires the phases together
├── paths.ts            # config dir, run dirs, create-pdf.py seeding
├── types.ts            # shared types (Step, RunState, EnvironmentDef, ...)
└── ui/                 # OpenTUI progress UI (tui.ts), headless fallback
                        #   (headless.ts), shared UiDriver interface (driver.ts)
```

### Environment registry

Subjects are supported by *data*, not code paths. Each environment is one registry entry:

```ts
mysql: {
  name: "mysql",
  binary: "mysql",
  healthCheck: "mysql --version",
  spawnCommand: "mysql",
  spawnArgs: ["-u", "root", "-p"],
  isDone: (buf) => /mysql>\s*$/.test(buf),
  prompts: [{ pattern: /Enter password:/i, label: "MySQL password", secret: true }],
}
```

Adding a new REPL (psql, R, MATLAB CLI...) is a new entry, not new machinery — the executor's completion detection, prompt interception, and session reuse all apply automatically.

### Screenshot pipeline

Screenshots must only ever capture a *finished* command. `run_command` resolves only on genuine completion — process exit (one-shot bash) or a prompt regex match (REPLs) — and the screenshot step is gated on that. Rendered output goes through xterm.js in headless Chromium so the PNG looks like a real terminal, not a text dump.

### What it can't do (v1 boundaries)

- Terminal-only: no browser-based or GUI lab tasks
- One command at a time — concurrent server/client setups (socket labs) aren't supported
- No `lab-helper resume` command yet; `state.json` exists to make resumability possible later
- No MCP integration

## Development

```sh
npm install
npm run build     # tsc -> dist/
npm run typecheck
```

Python's ReportLab is required for PDF assembly: `pip install reportlab`.

The Python assembler (`scripts/create-pdf.py`) is the source of truth; at runtime it's copied to `~/.config/lab-helper/temp/` so the harness keeps one canonical copy.

## Repository

- Spec: `AGENTS.md` (v1 build spec, definition of done)
- Worked plan example: `steps.md`
- License: see `LICENSE`

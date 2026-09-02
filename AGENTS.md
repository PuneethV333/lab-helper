# AGENTS.md — Lab Helper (v1 Build Spec)

## Repo state (read first)

This repository is **pre-scaffold**. There is no code yet — no `package.json`, `src/`, `scripts/`, `tsconfig.json`, or CI. Everything below this section is the **spec for what v1 must become**, not a description of the current tree. Do not look for `planner.ts`, `create-pdf.py`, or `state.json` — they don't exist. The companion `steps.md` referenced below is also a deliverable to create, not a file in the repo.

Consequences for an agent working here:

- There is no `npm run build`/`test`/`lint` yet; the Node toolchain (tsconfig, deps) must be bootstrapped as part of the work before any of that exists.
- The OpenTUI skill is vendored at `.agents/skills/opentui/SKILL.md` (pinned by `skills-lock.json` from `anomalyco/opentui`) — load the `opentui` skill and read its `docs/**/*.mdx` before writing any Phase 2 UI code instead of guessing the API from memory.
- `README.md` is a one-line stub; the README note about plaintext API keys (below) is still pending.
- The remote is `github.com/PuneethV333/lab-helper`; `AGENTS.md`, `.agents/`, and `skills-lock.json` are currently untracked.

## Goal

A CLI that automates PESU lab submissions: reads a lab-instruction PDF, executes the required commands, verifies each result, captures a clean terminal screenshot, and compiles everything into a submission PDF. Works across lab topics (DBMS, networking, OS, etc.), not just one subject.

## Problem it replaces

Manually running each command from a PDF, screenshotting the result, and assembling 40-50+ images into a PDF by hand. Prior naive automation hit a race condition: screenshots captured before the command actually finished.

## CLI

```
lab-helper run <path-to-lab.pdf> [--output <dir>]
```

- Reads config from `~/.config/lab-helper/config.json`
- Runs the full pipeline end-to-end, rendering live progress via OpenTUI
- On success: final PDF lands at `<output-dir>/submission.pdf` (default: cwd)
- On unrecoverable failure: halts the entire run immediately (see Retry & Failure Policy) — no partial/skip-and-continue behavior in v1

## Architecture — one model (Gemini), four phases

### Phase 0 — Preflight (runs automatically on every `lab-helper run`, halts before touching anything if it fails)

Split into two stages, since environment-specific checks depend on what the plan actually needs:

- **Global checks** (before Phase 1 — don't depend on the PDF's contents):
  - `~/.config/lab-helper/config.json` exists with a Gemini API key present
  - `python3` is on PATH
  - `reportlab` is importable (`python3 -c "import reportlab"`)
  - Playwright's Chromium is installed (run `playwright install chromium` automatically if missing, don't just fail — this one's safe to self-heal)
  - `node-pty`'s native binding loads on this platform
- **Environment checks** (after Phase 1 produces `steps.md`, before Phase 2 executes anything): for each distinct `environment` value referenced in the plan, verify its binary is installed (e.g. `mysql --version` for the `mysql` environment). If any is missing, halt with a clear, actionable message naming the exact tool and a install hint — don't start executing steps only to fail partway through on a missing binary.

Any preflight failure halts before Phase 2 begins — consistent with the run's overall halt-on-failure policy.

### Phase 1 — Plan

- Gemini receives the PDF directly as multimodal input (no separate `read_pdf` tool needed — Gemini ingests PDFs natively) and is prompted to extract lab steps
- Output: `steps.md` (format below), written to `~/.config/lab-helper/temp/<run-id>/steps.md`
- Parsed via `remark` into `Step[]`, validated with **Zod** immediately — malformed plan output halts the run before any command executes, rather than failing mid-run

### Phase 2 — Execute (model called fresh per step, not one long session)

Per step, in order:

1. `run_command(command, environment)` via the environment registry — resolves only on genuine completion (exit code for one-shot commands, prompt-regex match for REPLs)
   - **Session persistence**: if consecutive steps share an environment (e.g. steps 2-5 are all `mysql`), reuse the same open session/process — don't respawn per step. Respawn only on first use or when the environment changes. This matters for correctness: a `USE lab1;` step depends on the `CREATE DATABASE lab1;` from the previous step having run in the *same* session.
2. **Verify #1** (text) — Gemini checks captured output against the step's expected description
3. `take_screenshot()` — only callable once verify #1 passes; renders via `xterm.js` inside a single persistent Playwright page (browser launched once at startup, reused for the whole run)
4. **Verify #2** (vision) — Gemini checks the screenshot image itself matches the expected result (catches render/capture glitches verify #1 can't see)
5. On failure: verify #1 fail → retry the command; verify #2 fail → retry only the screenshot capture (never re-run a stateful command just because its screenshot came out wrong)

**Interactive input mid-command** (e.g. `mysql -u root -p` prompting for a password): this is handled entirely inside `executor.ts`, transparent to the model — verify #1 only ever sees the final resolved output, never a mid-stream prompt.

- Environment registry entries declare known prompts they might hit:
  ```ts
  mysql: {
    spawn: () => pty.spawn('mysql', ['-u', 'root', '-p']),
    isDone: (buf) => /mysql>\s*$/.test(buf),
    prompts: [{ pattern: /Enter password:/i, label: 'MySQL password', secret: true }],
  }
  ```
- While a command runs, the executor watches PTY output. If a registered prompt pattern matches before the `isDone` pattern, execution pauses: the UI asks the user for input (masked when `secret: true`), the response is written to the PTY, and output-watching resumes.
- **Generic fallback** for prompts nobody registered ahead of time: if PTY output hasn't changed for a configurable idle window (default 8s) and the process hasn't exited, surface "this command appears to be waiting for input" in the UI and let the user type a response, rather than the run silently hanging forever.

State is tracked externally in `state.json`, not in the model's conversation history — this bounds context size regardless of run length and makes the run resumable. `state.json` shape:

```ts
interface RunState {
  labId: string;
  currentStep: number;
  steps: {
    id: number;
    command: string;
    environment: string;
    status: 'pending' | 'running' | 'verify_output' | 'verify_screenshot' | 'done' | 'failed';
    retries: number;
    screenshotPath?: string;
  }[];
}
```

### Phase 3 — Assemble (Python + ReportLab)

- `create-pdf.py` is a deliverable of this v1 (not yet in the repo); it will be checked in at `scripts/create-pdf.py`. On first run, the harness copies it to `~/.config/lab-helper/temp/create-pdf.py` if not already present (keeps one canonical runtime copy, source-controlled).
- Once every step in `state.json` is `done`, the harness builds a JSON manifest of ordered `{ screenshotPath, command }` and invokes:
  ```
  python3 ~/.config/lab-helper/temp/create-pdf.py --manifest <path> --output ~/.config/lab-helper/temp/<run-id>/submission.pdf
  ```
- `create-pdf.py` (ReportLab): one page per screenshot, captioned with the step's command.
- Harness confirms exit code 0 and the file exists, then moves it from the temp path to `<output-dir>/submission.pdf`.
- Non-zero exit or missing output file → halt the run with a clear error (same policy as step failures).

**Build-time requirement**: don't just write `create-pdf.py` and assume it works — actually run it against a handful of sample images during development and confirm a real, correctly-captioned multi-page PDF is produced before considering this phase done.

## Distribution

Curl-based install script (`curl -fsSL <url>/install.sh | sh`), not a bare npm package — this project has a mixed Node + Python runtime footprint (ReportLab isn't npm's problem to solve), so a single installer needs to bootstrap both sides in one command, the way opencode's install experience does.

The installer's job:
- Check/require Node and Python3
- `npm install -g lab-helper` (the actual code is still published to npm — installer just automates getting there)
- `pip install reportlab` (or set up a venv for it)
- Ensure Playwright's Chromium is present
- Scaffold `~/.config/lab-helper/` and copy `scripts/create-pdf.py` into `~/.config/lab-helper/temp/`

Publishing to npm underneath is still worth doing even with a curl installer — it gives real versioning and a `lab-helper update` path (re-pulls latest npm version) without losing the one-command install experience.

## Config

`~/.config/lab-helper/config.json`:
```json
{
  "geminiApiKey": "...",
  "retryLimit": 5
}
```
Note: this stores the API key in plaintext on disk. Fine for a personal/local tool used by you and juniors individually — would need real secret handling if this ever became a shared/hosted service. Worth a one-line comment in the README so nobody copies this pattern into something bigger without thinking about it.

## Retry & Failure Policy

- Max **5** total retries per step, combined across verify #1 and verify #2 failures, tracked in `state.json.steps[i].retries`
- Exceeding 5 → **halt the entire run immediately**, mark that step `failed` in `state.json`, print a clear error via the UI, exit non-zero
- No skip-and-continue in v1 — a broken step means the run stops so it can be inspected, not silently produces an incomplete submission

## Directory layout (target tree — do not assume these files exist yet)

```
lab-helper/
├── src/
│   ├── cli.ts
│   ├── planner.ts        # Phase 1 — Gemini(PDF) -> steps.md
│   ├── parser.ts         # steps.md -> Step[] (remark + zod)
│   ├── environments/      # registry: bash.ts, mysql.ts, python.ts, ...
│   ├── executor.ts        # node-pty run_command + completion detection + session reuse
│   ├── verifier.ts        # verify #1 (text) + verify #2 (vision)
│   ├── renderer.ts        # xterm.js + persistent Playwright page
│   ├── pdf.ts             # invokes create-pdf.py, moves result to output dir
│   ├── state.ts           # state.json read/write, resumability
│   ├── config.ts          # reads ~/.config/lab-helper/config.json
│   └── ui/                # OpenTUI components
├── scripts/
│   └── create-pdf.py      # source of truth; copied to ~/.config/lab-helper/temp/ at runtime
├── package.json
└── AGENTS.md
```

## Gemini tool schema (execution phase)

```ts
run_command(command: string, environment: string) -> { exitCode: number | null, output: string, done: boolean }
take_screenshot() -> { path: string }   // throws if last run_command hasn't resolved done: true
```

No `submit()` tool — PDF assembly is triggered deterministically by the harness once `state.json` shows all steps `done`, not by model judgment.

## steps.md format

A full worked example belongs in a companion `steps.md` (a deliverable to create; it's not in the repo yet). The inline template is authoritative for now:

```markdown
## Step <n>
**Environment:** <bash | mysql | python | ...>
**Command:**
​```<language>
<the command>
​```
**Expected:**
<what a correct result looks like, in plain language>
```

## v1 scope boundaries (do not exceed)

- Terminal-only environments (bash + REPLs) — no browser-based lab tasks
- No MCP integration
- No `lab-helper resume` CLI command — `state.json` exists to make resumability *possible* later, but wiring up an actual resume flow is not required for v1
- OpenTUI for the terminal UI

## Definition of done for v1

- [ ] Runs against a real PDF end-to-end and produces a valid submission PDF
- [ ] Race condition confirmed fixed: screenshot only ever fires after `run_command` resolves `done: true`
- [ ] `create-pdf.py` actually executed against sample images and confirmed to produce a correct multi-page, captioned PDF
- [ ] A step exceeding 5 retries halts the run cleanly with a clear error, not a silent partial result
- [ ] At least one non-`bash` environment (e.g. `mysql`) works end-to-end, proving the registry pattern and session-reuse behavior generalize
- [ ] Preflight actually blocks a run when a required binary/config is missing, with a clear message — not a confusing failure mid-run
- [ ] A registered interactive prompt (mysql password) is correctly intercepted, requests input from the user, and resumes execution correctly
- [ ] The generic idle-timeout fallback is tested against at least one unregistered prompt to confirm the run doesn't hang silently
# lab-helper

Automates PESU lab submissions: reads a lab-instruction PDF, runs each required command in its own environment (bash, MySQL, Python REPLs), verifies output and screenshot, and compiles a submission PDF.

## Usage

```
lab-helper run <path-to-lab.pdf> [--output <dir>]
```

On success, `submission.pdf` lands in `<output-dir>` (default: current directory). Any unrecoverable failure halts the entire run immediately.

## Config

Reads `~/.config/lab-helper/config.json`:

```json
{
  "geminiApiKey": "...",
  "retryLimit": 5
}
```

Note: the Gemini API key is stored in plaintext on disk. This is acceptable for a personal/local tool, but don't copy this pattern into anything shared or hosted without real secret handling.

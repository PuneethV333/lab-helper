#!/bin/sh
# lab-helper installer: bootstraps Node + Python sides in one command.
# Usage: curl -fsSL <url>/install.sh | sh
set -e

have() { command -v "$1" >/dev/null 2>&1; }

fail() {
  echo "lab-helper install: $1" >&2
  exit 1
}

# --- Node ---
if ! have node; then
  fail "Node.js is required but not on PATH. Install Node 18+ from https://nodejs.org and re-run."
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || fail "Node 18+ required (found $(node --version))."

have npm || fail "npm not found (should ship with Node)."

# --- Python 3 ---
have python3 || fail "python3 is required but not on PATH. Install Python 3 and re-run."

# --- Install the CLI ---
echo "==> Installing lab-helper via npm (global)..."
npm install -g lab-helper

# --- ReportLab ---
if ! python3 -c "import reportlab" >/dev/null 2>&1; then
  echo "==> Installing reportlab for python3..."
  if python3 -m pip install --user reportlab >/dev/null 2>&1; then
    :
  else
    # PEP 668 externally-managed environments: fall back to a user venv.
    echo "    pip install --user failed (likely PEP 668); creating ~/.local/lab-helper-venv..."
    python3 -m venv "$HOME/.local/lab-helper-venv"
    "$HOME/.local/lab-helper-venv/bin/pip" install reportlab
    if have sudo; then
      ln -sf "$HOME/.local/lab-helper-venv/bin/python3" "$HOME/.local/bin/lab-helper-python3" 2>/dev/null || true
    fi
    cat <<EOF

NOTE: reportlab was installed into the venv at ~/.local/lab-helper-venv.
Add this to your shell profile so lab-helper's python3 picks it up:
  export PATH="$HOME/.local/lab-helper-venv/bin:\$PATH"
EOF
  fi
fi

# --- Playwright Chromium (self-healed at runtime too, but pre-fetch here) ---
echo "==> Ensuring Playwright Chromium is present..."
npx --yes playwright install chromium || echo "    (skipped; lab-helper will retry this automatically on first run)"

# --- Config scaffold ---
CONFIG_DIR="$HOME/.config/lab-helper"
mkdir -p "$CONFIG_DIR/temp"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  echo '{"geminiApiKey": "", "retryLimit": 5}' > "$CONFIG_DIR/config.json"
  echo "==> Scaffolded $CONFIG_DIR/config.json — add your Gemini API key."
fi

echo ""
echo "lab-helper installed."
echo "Next: put your Gemini API key in $CONFIG_DIR/config.json, then run:"
echo "  lab-helper run <path-to-lab.pdf> [--output <dir>]"

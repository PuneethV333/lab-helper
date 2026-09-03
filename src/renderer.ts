import http, { type Server } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const XTERM_JS = join(HERE, "..", "node_modules", "@xterm", "xterm", "lib", "xterm.mjs");
const XTERM_CSS = join(HERE, "..", "node_modules", "@xterm", "xterm", "css", "xterm.css");

const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/xterm.css">
  <style>
    html, body { margin: 0; padding: 0; background: #0d1117; }
    #stage {
      width: -moz-fit-content;
      width: fit-content;
      min-width: 320px;
      background: #0d1117;
    }
  </style>
</head>
<body>
  <div id="stage"></div>
  <script type="module">
    import { Terminal } from "/xterm.js";
    window.theme = {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
    };
    window.renderScreen = async (command, output) => {
      const lines = output.split("\\n");
      let cols = 60;
      for (const l of lines) cols = Math.max(cols, l.length + 2);
      cols = Math.min(cols, 140);
      let rows = Math.min(Math.max(lines.length + 3, 6), 40);
      document.getElementById("stage").replaceChildren();
      const term = new Terminal({
        cols,
        rows,
        cursorBlink: false,
        fontFamily: "monospace",
        fontSize: 14,
        lineHeight: 1.15,
        convertEol: true,
        theme: window.theme,
      });
      term.open(document.getElementById("stage"));
      if (command) term.writeln("\\x1b[1;32m$ " + command + "\\x1b[0m");
      term.write(output);
      return { cols, rows };
    };
  </script>
</body>
</html>`;

let cssCache: string | null = null;

export class ScreenRenderer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private server: Server | null = null;
  private baseUrl = "";

  async init(): Promise<void> {
    cssCache ??= readFileSync(XTERM_CSS, "utf8");
    this.server = await this.startServer();
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage({ viewport: { width: 1200, height: 800 } });
    await this.page.goto(this.baseUrl);
  }

  private startServer(): Promise<Server> {
    const xtermJs = readFileSync(XTERM_JS, "utf8");
    const css = cssCache!;
    const server = http.createServer((req, res) => {
      if (req.url === "/" ) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(INDEX_HTML);
        return;
      }
      if (req.url === "/xterm.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(xtermJs);
        return;
      }
      if (req.url === "/xterm.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(css);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise<Server>((resolveServer) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        this.baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolveServer(server);
      });
    });
  }

  /**
   * Render `command` + captured `output` into a fresh xterm.js terminal in
   * the shared Playwright page and screenshot it to `dest`.
   */
  async screenshot(command: string, output: string, dest: string): Promise<void> {
    if (!this.page) throw new Error("ScreenRenderer not initialized");
    mkdirSync(resolve(dirname(dest)), { recursive: true });
    // The index page is an ES module; wait until it has registered renderScreen.
    await this.page.waitForFunction(() => typeof (globalThis as { renderScreen?: unknown }).renderScreen === "function", { timeout: 10_000 });
    await this.page.evaluate(
      ({ command, output }) => window.renderScreen(command, output),
      { command, output },
    );
    // Allow a few frames for xterm to paint.
    await this.page.waitForTimeout(250);
    const el = await this.page.$("#stage");
    if (!el) throw new Error("terminal stage not found in renderer page");
    const absDest = resolve(dest);
    await el.screenshot({ path: absDest });
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.page = null;
    if (this.server) this.server.close();
    this.server = null;
  }
}

declare const window: {
  renderScreen: (command: string, output: string) => void;
  theme: Record<string, string>;
};
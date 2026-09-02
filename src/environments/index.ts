import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentDef } from "../types.js";

function findOnPath(binary: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const bashEnv: EnvironmentDef = {
  name: "bash",
  binary: "bash",
  healthCheck: "bash --version",
  spawnCommand: "bash",
  spawnArgs: ["-lc"],
  isDone: () => true,
  prompts: [],
};

const mysqlEnv: EnvironmentDef = {
  name: "mysql",
  binary: "mysql",
  healthCheck: "mysql --version",
  spawnCommand: "mysql",
  spawnArgs: ["-u", "root", "-p"],
  isDone: (s) => /(?:^|\n)(?:mysql|MariaDB \[[^\]]+\])>\s*$/.test(s),
  prompts: [{ pattern: /Enter password:/i, label: "MySQL password", secret: true }],
};

const pythonEnv: EnvironmentDef = {
  name: "python",
  binary: "python3",
  healthCheck: "python3 --version",
  spawnCommand: "python3",
  spawnArgs: ["-q"],
  isDone: (s) => /(?:^|\n)>>>\s*$/.test(s),
  prompts: [],
};

const sqlite3Env: EnvironmentDef = {
  name: "sqlite3",
  binary: "sqlite3",
  healthCheck: "sqlite3 --version",
  spawnCommand: "sqlite3",
  spawnArgs: [":memory:"],
  isDone: (s) => /(?:^|\n)sqlite>\s*$/.test(s),
  prompts: [],
};

const registry: Record<string, EnvironmentDef> = {
  bash: bashEnv,
  mysql: mysqlEnv,
  python: pythonEnv,
  sqlite3: sqlite3Env,
};

export function getEnvironment(name: string): EnvironmentDef | undefined {
  return registry[name];
}

export function knownEnvironments(): string[] {
  return Object.keys(registry);
}

export function resolveBinary(env: EnvironmentDef): string | null {
  return findOnPath(env.binary);
}

export function missingEnvironmentMessage(name: string): string {
  const known = knownEnvironments().sort().join(", ");
  return `Plan references environment "${name}" but it is not registered. Known environments: ${known}.`;
}
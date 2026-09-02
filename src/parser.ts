import { unified } from "unified";
import remarkParse from "remark-parse";
import { z } from "zod";
import type { Step } from "./types.js";

const StepSchema = z.object({
  id: z.number().int().nonnegative(),
  command: z.string().min(1),
  environment: z.string().min(1),
  expected: z.string(),
});

const StepsSchema = z.array(StepSchema);

export interface ParseResult {
  steps: Step[];
  error?: string;
}

interface Node {
  type: string;
  depth?: number;
  value?: string;
  children?: Node[];
  url?: string;
  [key: string]: unknown;
}

function visit(node: Node, cb: (n: Node) => void): void {
  cb(node);
  if (node.children) node.children.forEach((c) => visit(c, cb));
}

function nodeText(node: Node): string {
  return (node.children ?? [])
    .map((c) => (c.value ? String(c.value) : c.url ?? nodeText(c)))
    .filter(Boolean)
    .join("");
}

function fullText(node: Node): string {
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.type === "text" || n.type === "inlineCode") parts.push(String(n.value ?? ""));
    if (n.type === "code") parts.push(String(n.value ?? ""));
    n.children?.forEach(walk);
  };
  walk(node);
  return parts.join("");
}

/**
 * Parse steps.md (remark AST) into Step[]. Rejects malformed or
 * incomplete plans rather than guessing.
 */
export function parseSteps(markdown: string): ParseResult {
  try {
    const tree = unified().use(remarkParse).parse(markdown);
    const tokens: Node[] = [];
    visit(tree as unknown as Node, (t) => tokens.push(t));
    const steps: Step[] = [];
    let current: Partial<Step> | null = null;

    const commit = (): void => {
      if (current && current.command && current.command.trim() !== "") {
        steps.push({
          id: current.id ?? steps.length,
          command: current.command.trim(),
          environment: current.environment?.trim() || "bash",
          expected: current.expected?.trim() ?? "",
        });
      }
      current = null;
    };

    for (const token of tokens) {
      if (token.type === "heading" && token.depth === 2) {
        commit();
        const m = /^Step\s+(\d+)/i.exec(nodeText(token));
        current = { id: m ? Number(m[1]) : undefined };
        continue;
      }
      if (!current) continue;

      if (token.type === "paragraph") {
        const text = nodeText(token);
        const envMatch = /^\*\*Environment:\s*\*\*\s*([\w-]+)/i.exec(text);
        if (envMatch) {
          current.environment = envMatch[1];
          continue;
        }
        const expMatch = /^\*\*Expected[^:]*:\s*\*\*\s*([\s\S]+)$/i.exec(text);
        if (expMatch) {
          current.expected = expMatch[1].trim();
          continue;
        }
      }

      if (token.type === "listItem" && current.command === undefined) {
        const text = fullText(token);
        const m = /^\*\*Command:\s*\*\*[\s\S]*?\n([\s\S]+)$/is.exec(text);
        if (m) current.command = m[1].trim();
      }
    }
    commit();

    return { steps };
  } catch (e) {
    return { steps: [], error: `Failed to parse steps.md: ${(e as Error).message}` };
  }
}

export function validateSteps(steps: Step[]): { steps: Step[]; error?: string } {
  try {
    const validated = StepsSchema.parse(steps);
    return { steps: validated };
  } catch (e) {
    const issues = (e as z.ZodError).issues ?? [];
    const detail = issues.map((i) => `steps[${i.path[0] ?? "?"}].${i.path[1] ?? "?"}: ${i.message}`).join("; ");
    return { steps: [], error: `steps.md produced an invalid plan: ${detail || String(e)}` };
  }
}
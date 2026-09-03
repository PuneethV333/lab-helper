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

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
}

/** Plain text of a node's children, preserving inline emphasis content. */
function nodeText(node: MdNode): string {
  return (node.children ?? []).map((c) => String(c.value ?? "") + (c.children ? nodeText(c) : "")).join("");
}

/** Whether a paragraph contains a leading `**Label:**` strong marker. */
function paragraphLabel(node: MdNode): { label: string; rest: string } | null {
  const children = node.children;
  if (!children || children.length === 0) return null;
  const first = children[0];
  if (!first || first.type !== "strong") return null;
  const label = nodeText(first).trim();
  if (!/^[A-Za-z]+\*?:$/.test(label)) return null;
  // Rest stops at the next strong marker (e.g. **Command:** on the same line).
  const stopAt = children.findIndex((c, i) => i > 0 && c.type === "strong");
  const restChildren = stopAt > 0 ? children.slice(1, stopAt) : children.slice(1);
  const restText = nodeText({ type: "p", children: restChildren } as MdNode).trim();
  return { label: label.replace(/:$/, ""), rest: restText };
}

function isStepHeading(node: MdNode): { id: number; rawId: string } | null {
  if (node.type !== "heading" || node.depth !== 2) return null;
  const text = nodeText(node);
  const m = /^Step\s+(\d+|[A-Za-z\d]*[A-Za-z][A-Za-z\d]*)/i.exec(text);
  return m ? { id: extractIdNumber(m[1]), rawId: m[1] } : null;
}

/** Extract a numeric ordering key from ids like "1", "A1", "3b", "A", "B". */
function extractIdNumber(raw: string): number {
  const digits = /[A-Za-z]*(\d+)[A-Za-z]*/.exec(raw);
  if (digits) return Number(digits[1]);
  // Letter-only ids (A, B, C, ...) map to 1, 2, 3, ...
  const upper = raw.toUpperCase();
  let n = 0;
  for (const ch of upper) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Parse steps.md (remark AST) into Step[]. Rejects malformed or
 * incomplete plans rather than guessing.
 */
export function parseSteps(markdown: string): ParseResult {
  try {
    const tree = unified().use(remarkParse).parse(markdown) as unknown as MdNode & { children: MdNode[] };
    const steps: Step[] = [];
    let current: Partial<Step> | null = null;

    const commit = (): void => {
      if (current && current.command && current.command.trim() !== "") {
        steps.push({
          id: current.id ?? steps.length,
          rawId: current.rawId,
          command: current.command.trim(),
          environment: current.environment?.trim() || "bash",
          expected: current.expected?.trim() ?? "",
        });
      }
      current = null;
    };

    for (const node of tree.children ?? []) {
      const heading = isStepHeading(node);
      if (heading) {
        commit();
        current = { id: heading.id, rawId: heading.rawId };
        continue;
      }
      if (!current && node.type !== "heading") continue;
      if (!current) continue;

      if (node.type === "code" && current.command === undefined) {
        current.command = String(node.value ?? "");
        continue;
      }

      if (node.type === "paragraph") {
        const labeled = paragraphLabel(node);
        if (!labeled) continue;
        if (/^environment/i.test(labeled.label)) {
          current.environment = labeled.rest.toLowerCase();
        } else if (/^expected/i.test(labeled.label)) {
          current.expected = labeled.rest;
        }
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
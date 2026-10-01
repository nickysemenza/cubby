import { z } from "zod";

/**
 * Evaluates a manifest `display.readPath` against a row: dotted keys, `[n]`
 * indexing, and a `[]` projection that maps the rest of the path over an
 * array (`sourceRefs[].source` reads every element's `source`;
 * `category.path[0].name` reads the first path node). A missing link anywhere
 * on the path reads as `undefined`, never throws — a partial list row or an
 * older cached page simply shows an empty cell.
 */
type Step =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "each" };

const SEGMENT = /([A-Za-z_]\w*)|\[(\d*)\]/gu;
const stepsCache = new Map<string, readonly Step[]>();

function parseSteps(path: string): readonly Step[] {
  const cached = stepsCache.get(path);
  if (cached) return cached;
  const steps = [...path.matchAll(SEGMENT)].map((match): Step => {
    if (match[1] !== undefined) return { kind: "key", key: match[1] };
    return match[2] === ""
      ? { kind: "each" }
      : { kind: "index", index: Number(match[2]) };
  });
  stepsCache.set(path, steps);
  return steps;
}

const recordSchema = z.record(z.string(), z.unknown());

function walk(value: unknown, steps: readonly Step[]): unknown {
  let current = value;
  for (const [position, step] of steps.entries()) {
    if (current === null || current === undefined) return undefined;
    if (step.kind === "each") {
      if (!Array.isArray(current)) return undefined;
      const rest = steps.slice(position + 1);
      return current
        .map((item) => walk(item, rest))
        .filter((item) => item !== undefined);
    }
    if (step.kind === "index") {
      current = Array.isArray(current) ? current[step.index] : undefined;
      continue;
    }
    const record = recordSchema.safeParse(current);
    current = record.success ? record.data[step.key] : undefined;
  }
  return current;
}

export function readPathValue(record: unknown, path: string): unknown {
  return walk(record, parseSteps(path));
}

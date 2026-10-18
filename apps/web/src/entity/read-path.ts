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

// oxlint-disable-next-line anti-slop/no-unknown-returns -- A row path is untyped by construction; the caller parses the projected value.
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
    // An own-property read of a plain object (what `z.record` accepted), not a
    // `z.record` parse: that copied the object at every step of every cell's
    // path.
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    current = Object.getOwnPropertyDescriptor(current, step.key)?.value;
  }
  return current;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- The projection boundary: rows in, an unparsed value out for the scalar reader to parse.
export function readPathValue(record: unknown, path: string): unknown {
  return walk(record, parseSteps(path));
}

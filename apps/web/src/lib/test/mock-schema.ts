// Schema-driven mock-data generator for tests and fixtures.
//
// `mock(schema)` walks a Zod 4 schema and produces a value that PASSES that
// schema (`schema.parse(mock(schema))` does not throw — see the round-trip test).
// It replaces hand-written scaffolding in fixtures: spell out only the fields a
// test asserts on (via `overrides`), and let this fill the rest.
//
// IMPORTANT: this module imports `@faker-js/faker`, which is a devDependency.
// It must only ever be imported from `*.fixtures.ts` / `*.test.ts` files, never
// from application code, or faker will be pulled into the production bundle.
// `knip` + `build:cf` are the backstops.
//
// Design notes (Zod 4.4.x internals, verified empirically):
// - The runtime shape lives at `schema._zod.def`; `def.type` is the discriminator.
// - `.brand()` is type-only — a branded id is just a `string` schema at runtime,
//   so we emit a uuid and the final `as z.infer<T>` cast lines the brand up.
// - `.refine()` does NOT wrap — `amount` stays `type: "object"`, so the
//   omit-optionals policy below makes `{ value, unit }` (no `upperValue`) which
//   satisfies its `upperValue > value` refinement for free.
// - Value policy: `.optional()` is OMITTED and `.nullable()`/`.nullish()` are
//   always `null` in the generated base (both satisfy round-trips). When a
//   nullable field's inner value is what a test actually needs, pass it via
//   `overrides` — the base will never synthesize the inner type for you.
// - Faker hints live in schema `.meta({ mock: "food.ingredient" })` as dot-paths
//   (strings, so `@cubby/schemas` stays faker-free); resolved here at gen time.

import { faker } from "@faker-js/faker";
import type { z } from "zod";

export interface MockOptions<T> {
  /** Values to overlay onto the generated object. Objects deep-merge; arrays,
   * dates and primitives replace wholesale. Anything a test asserts on belongs
   * here so it is never random. */
  overrides?: DeepPartial<T>;
  /** Seed faker first for deterministic output. */
  seed?: number;
  /** Generate values for `.optional()` fields instead of omitting them. */
  fillOptionals?: boolean;
}

type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends Date
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

// Recursion guard for `.lazy()` (recursive schemas like the location tree).
const MAX_DEPTH = 4;

/** Generate mock data that satisfies `schema`. */
export function mock<T extends z.ZodType>(
  schema: T,
  opts: MockOptions<z.infer<T>> = {},
): z.infer<T> {
  if (opts.seed !== undefined) faker.seed(opts.seed);
  const base = gen(schema, 0, opts.fillOptionals ?? false);
  const merged =
    opts.overrides !== undefined ? deepMerge(base, opts.overrides) : base;
  return merged as z.infer<T>;
}

// biome-ignore lint/suspicious/noExplicitAny: walking Zod's internal def shape.
type AnyDef = { type: string; [k: string]: any };
const defOf = (s: z.ZodType): AnyDef =>
  // biome-ignore lint/suspicious/noExplicitAny: internal access, see header.
  (s as any)._zod.def;

/** Read a `{ mock }` string hint off a schema's metadata, if present. */
const mockHint = (s: z.ZodType): string | undefined => {
  const m = s.meta?.()?.mock;
  return typeof m === "string" ? m : undefined;
};

/** Resolve a faker dot-path like "food.ingredient" and call it (preserving `this`). */
function callFakerPath(path: string): unknown {
  const parts = path.split(".");
  // biome-ignore lint/suspicious/noExplicitAny: faker is a deep dynamic namespace.
  let ctx: any = faker;
  // biome-ignore lint/suspicious/noExplicitAny: ditto.
  let parent: any = faker;
  for (const p of parts) {
    parent = ctx;
    ctx = ctx?.[p];
    if (ctx == null) return undefined;
  }
  return typeof ctx === "function" ? ctx.call(parent) : ctx;
}

// biome-ignore lint/suspicious/noExplicitAny: checks are Zod-internal.
const readChecks = (checks: any[] | undefined) => {
  let intFmt = false;
  let minLen: number | undefined;
  let maxLen: number | undefined;
  let gt: number | undefined;
  let lt: number | undefined;
  for (const c of checks ?? []) {
    const d = c?._zod?.def ?? c;
    if (d.check === "number_format" && String(d.format).includes("int"))
      intFmt = true;
    if (d.check === "min_length") minLen = d.minimum;
    if (d.check === "max_length") maxLen = d.maximum;
    if (d.check === "length_equals") {
      minLen = d.length;
      maxLen = d.length;
    }
    if (d.check === "greater_than") gt = d.value;
    if (d.check === "less_than") lt = d.value;
  }
  return { intFmt, minLen, maxLen, gt, lt };
};

function genString(def: AnyDef): string {
  switch (def.format) {
    case "uuid":
    case "guid":
    case "nanoid":
    case "cuid":
    case "cuid2":
    case "ulid":
      return faker.string.uuid();
    case "email":
      return faker.internet.email();
    case "url":
      return faker.internet.url();
    case "emoji":
      return faker.internet.emoji();
    case "datetime":
    case "date":
      return faker.date.recent().toISOString();
  }
  const { minLen, maxLen } = readChecks(def.checks);
  let s = faker.lorem.words(3);
  if (minLen != null && s.length < minLen) s = s.padEnd(minLen, "x");
  if (maxLen != null && s.length > maxLen) s = s.slice(0, maxLen);
  if (s.length === 0) s = "x";
  return s;
}

function genNumber(def: AnyDef): number {
  const { intFmt, gt, lt } = readChecks(def.checks);
  const min = gt != null ? gt + (intFmt ? 1 : 0.01) : 1;
  const max = lt != null ? lt - (intFmt ? 1 : 0.01) : min + 1000;
  return intFmt
    ? faker.number.int({ min: Math.ceil(min), max: Math.floor(max) })
    : faker.number.float({ min, max, fractionDigits: 2 });
}

function gen(
  schema: z.ZodType,
  depth: number,
  fillOptionals: boolean,
): unknown {
  // An explicit faker hint wins over type-driven generation.
  const hint = mockHint(schema);
  if (hint) {
    const v = callFakerPath(hint);
    if (v !== undefined) return v;
  }

  const def = defOf(schema);
  const recurse = (s: z.ZodType, d = depth) => gen(s, d, fillOptionals);

  switch (def.type) {
    case "string":
      return genString(def);
    case "number":
      return genNumber(def);
    case "int":
      return genNumber({
        ...def,
        checks: [
          { check: "number_format", format: "int" },
          ...(def.checks ?? []),
        ],
      });
    case "bigint":
      return BigInt(faker.number.int({ min: 1, max: 1000 }));
    case "boolean":
      return faker.datatype.boolean();
    case "date":
      return faker.date.recent();
    case "enum":
      return faker.helpers.arrayElement(Object.values(def.entries));
    case "literal":
      return def.values[0];
    case "null":
      return null;
    case "undefined":
    case "void":
      return undefined;
    case "any":
    case "unknown":
      return {};
    case "nan":
      return Number.NaN;
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        def.shape as Record<string, z.ZodType>,
      )) {
        const v = recurse(child);
        if (v !== undefined) out[key] = v; // omit optionals (undefined)
      }
      return out;
    }
    case "array": {
      const { minLen } = readChecks(def.checks);
      const n = Math.max(minLen ?? 1, 1);
      return Array.from({ length: n }, () => recurse(def.element));
    }
    case "tuple":
      return (def.items ?? []).map((it: z.ZodType) => recurse(it));
    case "optional":
      return fillOptionals ? recurse(def.innerType) : undefined;
    case "nullable":
    case "nullish":
      return null;
    case "default":
    case "prefault": {
      const dv = def.defaultValue;
      return typeof dv === "function" ? dv() : dv;
    }
    case "catch":
      return recurse(def.innerType);
    case "readonly":
      return recurse(def.innerType);
    case "lazy":
      return depth >= MAX_DEPTH ? undefined : recurse(def.getter(), depth + 1);
    case "union": // discriminated unions report type "union"; first option is deterministic
      return recurse(def.options[0]);
    case "intersection": {
      const a = recurse(def.left);
      const b = recurse(def.right);
      return isPlain(a) && isPlain(b) ? { ...a, ...b } : (b ?? a);
    }
    case "record": {
      const k = String(recurse(def.keyType) ?? "key");
      return { [k]: recurse(def.valueType) };
    }
    case "map":
      return new Map([[recurse(def.keyType), recurse(def.valueType)]]);
    case "set":
      return new Set([recurse(def.valueType)]);
    case "pipe": {
      // Coercions / transforms: generate the input side, then run the whole
      // schema to apply the transform. Fall back to the raw input on failure.
      const input = recurse(def.in);
      try {
        // biome-ignore lint/suspicious/noExplicitAny: parse to apply transform.
        return (schema as any).parse(input);
      } catch {
        return input;
      }
    }
    default:
      throw new Error(
        `mock(): unhandled Zod type "${def.type}". Add a handler in mock-schema.ts or supply an override.`,
      );
  }
}

// biome-ignore lint/suspicious/noExplicitAny: structural runtime check.
const isPlain = (v: any): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  (v.constructor === Object || v.constructor === undefined);

/** Deep-merge overrides onto a generated base. Plain objects recurse; arrays,
 * dates, class instances and primitives replace wholesale. */
// biome-ignore lint/suspicious/noExplicitAny: merge is structural by nature.
function deepMerge(base: any, over: any): any {
  if (over === undefined) return base;
  if (!isPlain(over) || !isPlain(base)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

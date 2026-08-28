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
//   so we emit a uuid and let the final schema parse preserve its inferred brand.
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

interface MockOptions<T> {
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
  return schema.parse(merged);
}

type MockValue =
  | bigint
  | boolean
  | Date
  | Map<MockValue, MockValue>
  | MockValue[]
  | null
  | number
  | object
  | Set<MockValue>
  | string
  | symbol
  | undefined;
type RuntimeCheck = {
  _zod?: { def: RuntimeCheck };
  check?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  length?: number;
  value?: number;
  pattern?: RegExp;
};
type RuntimeDefinition = {
  type: string;
  format?: string;
  checks?: readonly RuntimeCheck[];
  entries?: Readonly<Record<string, string | number>>;
  values?: readonly MockValue[];
  shape?: Readonly<Record<string, z.ZodType>>;
  element?: z.ZodType;
  items?: readonly z.ZodType[];
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  in?: z.ZodType;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  defaultValue?: MockValue | (() => MockValue);
  getter?: () => z.ZodType;
};

// SAFETY: Zod 4 exposes the discriminated runtime definition through `_zod.def`;
// RuntimeDefinition names only the fields this generator reads from that public core contract.
const defOf = (s: z.ZodType): RuntimeDefinition =>
  s._zod.def as RuntimeDefinition;

const isMockValue = <TValue>(value: TValue): value is TValue & MockValue =>
  value === undefined || value === null || typeof value !== "function";

const isStringValue = <TValue>(value: TValue): value is TValue & string =>
  typeof value === "string";
const isDefaultFactory = <TValue>(
  value: TValue,
): value is TValue & (() => MockValue) => typeof value === "function";

/** Read a `{ mock }` string hint off a schema's metadata, if present. */
const mockHint = (s: z.ZodType): string | undefined => {
  const m = s.meta?.()?.mock;
  return isStringValue(m) ? m : undefined;
};

/**
 * Read a `{ mockValue }` literal off a schema's metadata, if present.
 *
 * The escape hatch for constraints this generator cannot synthesize a passing
 * value for — chiefly `.regex()`, where nothing type-driven can know the
 * pattern (`faker.helpers.fromRegExp` is not a substitute: it emits escape
 * sequences literally, so `\.` becomes a backslash and the result fails the
 * very pattern it was built from). A schema that pins a shape by regex declares
 * one known-good example and the round-trip test passes honestly, instead of
 * the regex being dropped just to keep the generator happy.
 *
 * Stays a plain literal, never a faker path, so `@cubby/schemas` remains
 * faker-free (see the header note).
 */
const mockValueHint = (s: z.ZodType): MockValue | undefined => {
  const value = s.meta?.()?.mockValue;
  return isMockValue(value) ? value : undefined;
};

/** Resolve a faker dot-path like "food.ingredient" and call it (preserving `this`). */
type FakerFunction = () => MockValue;
type FakerPathValue = MockValue | FakerFunction;
const isFakerFunction = <TValue>(
  value: TValue,
): value is TValue & FakerFunction => typeof value === "function";
interface FakerOwner {}
const readFakerMember = (
  owner: FakerOwner,
  key: string,
): FakerPathValue | undefined =>
  Object.getOwnPropertyDescriptor(owner, key)?.value;

function callFakerPath(path: string): MockValue | undefined {
  const parts = path.split(".");
  let ctx: FakerOwner = faker;
  let parent: FakerOwner = faker;
  for (const [index, part] of parts.entries()) {
    parent = ctx;
    const value = readFakerMember(ctx, part);
    if (value == null) return undefined;
    if (index === parts.length - 1)
      return isFakerFunction(value) ? value.call(parent) : value;
    if (!isFakerOwner(value)) return undefined;
    ctx = value;
  }
  return undefined;
}

const isFakerOwner = <TValue>(value: TValue): value is TValue & FakerOwner =>
  typeof value === "object" && value !== null;

const readChecks = (checks: readonly RuntimeCheck[] | undefined) => {
  let intFmt = false;
  let minLen: number | undefined;
  let maxLen: number | undefined;
  let gt: number | undefined;
  let lt: number | undefined;
  let regex: RegExp | undefined;
  for (const c of checks ?? []) {
    const d = c._zod?.def ?? c;
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
    // `.regex(re)` compiles to a `string_format` check with `format: "regex"`
    // and the source `RegExp` on `pattern` (verified against Zod 4.4.x
    // internals — see the module header). Shortcodes and a handful of other
    // schemas (`plainDate`, fingerprints) rely on this to generate a value
    // that actually satisfies the constraint instead of falling back to
    // lorem words that can never match.
    if (d.check === "string_format" && d.format === "regex" && d.pattern) {
      regex = d.pattern;
    }
  }
  return { intFmt, minLen, maxLen, gt, lt, regex };
};

/**
 * Expand a bracketed character class body (no leading/trailing `[`/`]`) into
 * its member characters. Supports `a-z`-style ranges and a leading `^`
 * negation (falls back to a generic alphanumeric set minus the excluded
 * chars — good enough for a mock generator, not a full regex engine).
 */
function expandCharClass(body: string): string[] {
  let negate = false;
  let b = body;
  if (b.startsWith("^")) {
    negate = true;
    b = b.slice(1);
  }
  const chars: string[] = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === "\\" && b[i + 1] === "d") {
      chars.push(..."0123456789".split(""));
      i += 1;
    } else if (b[i + 1] === "-" && b[i + 2] !== undefined) {
      const start = b.charCodeAt(i);
      const end = b.charCodeAt(i + 2);
      for (let code = start; code <= end; code++) {
        chars.push(String.fromCharCode(code));
      }
      i += 2;
    } else {
      const ch = b[i];
      if (ch !== undefined) chars.push(ch);
    }
  }
  if (negate) {
    const all =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(
        "",
      );
    return all.filter((c) => !chars.includes(c));
  }
  return chars;
}

/**
 * Generate a string that satisfies a (simple, anchored) regex: literal chars,
 * `\d`, `[...]` classes (with ranges), and `{n}` / `{n,m}` / `*` / `+` / `?`
 * quantifiers on the preceding atom. Not a general regex engine — covers the
 * patterns actually used in `@cubby/schemas` (shortcodes, `plainDate`,
 * hex fingerprints); an unsupported construct just gets consumed literally,
 * which is a wrong-but-harmless value in the worst case rather than a throw.
 */
function genFromRegex(pattern: RegExp): string {
  const src = pattern.source.replace(/^\^/, "").replace(/\$$/, "");

  // `anyShortcodeSchema` starts with a non-capturing alternation of allowed
  // prefixes, e.g. `(?:PRD-|RCP-|ING-)`. Pick one branch before walking the
  // remaining atoms; treating the group syntax as literals produces a value
  // that can never pass the schema it came from.
  const leadingAlternation = src.match(/^\(\?:([^()]+)\)(.*)$/);
  if (leadingAlternation) {
    const [, alternatives, rest] = leadingAlternation;
    if (alternatives !== undefined && rest !== undefined) {
      const prefix = faker.helpers.arrayElement(alternatives.split("|"));
      return genFromRegex(new RegExp(`^${prefix}${rest}$`));
    }
  }

  let out = "";
  let i = 0;
  while (i < src.length) {
    let atomChars: string[] | undefined;
    let literal: string | undefined;
    if (src[i] === "\\") {
      const next = src[i + 1];
      if (next === "d") atomChars = "0123456789".split("");
      else if (next === "w")
        atomChars =
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(
            "",
          );
      else literal = next;
      i += 2;
    } else if (src[i] === "[") {
      const end = src.indexOf("]", i);
      atomChars = expandCharClass(src.slice(i + 1, end));
      i = end + 1;
    } else {
      literal = src[i];
      i += 1;
    }

    let count = 1;
    if (src[i] === "{") {
      const end = src.indexOf("}", i);
      const [minStr, maxStr] = src.slice(i + 1, end).split(",");
      const min = Number(minStr);
      count =
        maxStr === undefined
          ? min
          : faker.number.int({
              min,
              max: maxStr === "" ? min : Number(maxStr),
            });
      i = end + 1;
    } else if (src[i] === "*") {
      count = faker.number.int({ min: 0, max: 3 });
      i += 1;
    } else if (src[i] === "+") {
      count = faker.number.int({ min: 1, max: 3 });
      i += 1;
    } else if (src[i] === "?") {
      count = faker.number.int({ min: 0, max: 1 });
      i += 1;
    }

    for (let n = 0; n < count; n++) {
      if (atomChars) out += faker.helpers.arrayElement(atomChars);
      else if (literal !== undefined) out += literal;
    }
  }
  return out;
}

function genString(def: RuntimeDefinition): string {
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
  const { minLen, maxLen, regex } = readChecks(def.checks);
  if (regex) return genFromRegex(regex);
  let s = faker.lorem.words(3);
  if (minLen != null && s.length < minLen) s = s.padEnd(minLen, "x");
  if (maxLen != null && s.length > maxLen) s = s.slice(0, maxLen);
  if (s.length === 0) s = "x";
  return s;
}

function genNumber(def: RuntimeDefinition): number {
  const { intFmt, gt, lt } = readChecks([def, ...(def.checks ?? [])]);
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
): MockValue | undefined {
  // An explicit literal wins over everything — it exists precisely because the
  // type-driven path cannot satisfy the schema's own constraints.
  const literal = mockValueHint(schema);
  if (literal !== undefined) return literal;

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
      return faker.helpers.arrayElement(Object.values(def.entries ?? {}));
    case "literal":
      return def.values?.[0];
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
      const entries: Array<readonly [string, MockValue]> = [];
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        const v = recurse(child);
        if (v !== undefined) entries.push([key, v]); // omit optionals (undefined)
      }
      return Object.fromEntries(entries);
    }
    case "array": {
      const { minLen } = readChecks(def.checks);
      const n = Math.max(minLen ?? 1, 1);
      const element = def.element;
      return element ? Array.from({ length: n }, () => recurse(element)) : [];
    }
    case "tuple":
      return (def.items ?? []).map((it) => recurse(it));
    case "optional":
      return fillOptionals && def.innerType
        ? recurse(def.innerType)
        : undefined;
    case "nullable":
    case "nullish":
      return null;
    case "default":
    case "prefault": {
      const dv = def.defaultValue;
      return isDefaultFactory(dv) ? dv() : dv;
    }
    case "catch":
      return def.innerType ? recurse(def.innerType) : undefined;
    case "readonly":
      return def.innerType ? recurse(def.innerType) : undefined;
    case "lazy":
      return depth >= MAX_DEPTH || def.getter === undefined
        ? undefined
        : recurse(def.getter(), depth + 1);
    case "union": // discriminated unions report type "union"; first option is deterministic
      return def.options?.[0] ? recurse(def.options[0]) : undefined;
    case "intersection": {
      const a = def.left ? recurse(def.left) : undefined;
      const b = def.right ? recurse(def.right) : undefined;
      return isPlain(a) && isPlain(b) ? { ...a, ...b } : (b ?? a);
    }
    case "record": {
      const k = String(def.keyType ? recurse(def.keyType) : "key");
      return { [k]: def.valueType ? recurse(def.valueType) : undefined };
    }
    case "map":
      return new Map([
        [
          def.keyType ? recurse(def.keyType) : undefined,
          def.valueType ? recurse(def.valueType) : undefined,
        ],
      ]);
    case "set":
      return new Set([def.valueType ? recurse(def.valueType) : undefined]);
    case "pipe": {
      // Coercions / transforms: generate the input side, then run the whole
      // schema to apply the transform. Fall back to the raw input on failure.
      const input = def.in ? recurse(def.in) : undefined;
      try {
        const parsed = schema.safeParse(input);
        return parsed.success && isMockValue(parsed.data) ? parsed.data : input;
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

const isPlain = <TValue>(value: TValue): value is TValue & object =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Deep-merge overrides onto a generated base. Plain objects recurse; arrays,
 * dates, class instances and primitives replace wholesale. */
function deepMerge<TBase, TOverride>(
  base: TBase,
  over: TOverride,
): MockValue | undefined {
  if (over === undefined) return isMockValue(base) ? base : undefined;
  if (!isPlain(over) || !isPlain(base))
    return isMockValue(over) ? over : undefined;
  const values = new Map<string, MockValue>();
  for (const [key, value] of Object.entries(base))
    if (isMockValue(value)) values.set(key, value);
  for (const [key, value] of Object.entries(over)) {
    const merged = deepMerge(values.get(key), value);
    if (merged !== undefined) values.set(key, merged);
  }
  return Object.fromEntries(values);
}

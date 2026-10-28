import { customAlphabet } from "nanoid";
import { z } from "zod";
import { SHORTCODE_BODY_LENGTH, SHORTCODE_CHARS } from "./shortcode-alphabet";
import {
  SHORTCODE_SCHEMA,
  shortcodeBodyPattern,
  type ShortcodeFor,
} from "./shortcode-schema";

export {
  LEGACY_SHORTCODE_BODY_LENGTH,
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_BODY_PATTERN,
  SHORTCODE_CHARS,
} from "./shortcode-alphabet";
import {
  SHORTCODE_PREFIX,
  SHORTCODE_LENGTH,
  type ShortcodeType,
} from "./generated/shortcode-registry.gen";

export {
  SHORTCODE_PREFIX,
  SHORTCODE_LENGTH,
  type ShortcodeType,
} from "./generated/shortcode-registry.gen";

/** Every canonical prefix that may legitimately cross an API or MCP boundary. */
export const PUBLIC_SHORTCODE_PREFIXES = Object.values(SHORTCODE_PREFIX);

/**
 * The single-letter prefixes still needed for physical location and product QR
 * labels that predate the canonical prefix format.
 *
 * INBOUND ONLY. Nothing emits these — `parseShortcode` rewrites a legacy code to
 * its canonical form, preserving each code's 4-char body (`P-4K7M` becomes
 * `PRD-4K7M`). This table is the only accepted set of swaps; it is deliberately
 * not part of the entity manifest, so no generated surface (catalog, inspector,
 * native) advertises the legacy form.
 */
export const LEGACY_SHORTCODE_PREFIX = {
  "P-": "product",
  "L-": "location",
} as const satisfies Record<string, ShortcodeType>;

const isLegacyPrefix = (
  prefix: string,
): prefix is keyof typeof LEGACY_SHORTCODE_PREFIX =>
  Object.hasOwn(LEGACY_SHORTCODE_PREFIX, prefix);

const PREFIX_TO_TYPE: Partial<Record<string, ShortcodeType>> = {};
const isShortcodeType = (type: string): type is ShortcodeType =>
  Object.hasOwn(SHORTCODE_PREFIX, type);

for (const [type, prefix] of Object.entries(SHORTCODE_PREFIX)) {
  if (isShortcodeType(type)) {
    PREFIX_TO_TYPE[prefix] = type;
  }
}

/**
 * A schema for a code whose entity isn't known until runtime — an MCP tool
 * whose target type is chosen by another field (`search.similar`'s
 * `pair`) or read off the prefix itself (`image.attach_file`).
 *
 * Still a `ZodString` with a real `pattern`, just one alternating over the
 * allowed prefixes, so the published JSON Schema keeps telling an agent which
 * codes are legal here. A bare `z.string()` would silently drop that hint —
 * which is exactly what the catalog's pattern test exists to catch.
 */
export const anyShortcodeSchema = <T extends ShortcodeType>(
  types: readonly [T, ...T[]],
) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      new RegExp(
        `^(?:${types.map((t) => `${SHORTCODE_PREFIX[t]}${shortcodeBodyPattern(t)}`).join("|")})$`,
      ),
      `Expected one of: ${types.map((t) => `${SHORTCODE_PREFIX[t]}…`).join(", ")}`,
    );

/**
 * The shortcode schema for an entity, preserving its exact branded type through
 * the generic lookup. Lets a generic surface (the MCP CRUD toolset, a route
 * param) ask for "this entity's public id schema" without a switch.
 */
export const shortcodeSchema = <T extends ShortcodeType>(
  type: T,
): (typeof SHORTCODE_SCHEMA)[T] => SHORTCODE_SCHEMA[type];

/** Validate and normalize one entity's public identifier. */
export function parseShortcodeFor<T extends ShortcodeType, TInput>(
  type: T,
  value: TInput,
): ShortcodeFor<T>;
export function parseShortcodeFor<TInput>(
  type: ShortcodeType,
  value: TInput,
): AnyShortcode {
  return SHORTCODE_SCHEMA[type].parse(value);
}

// Per-entity named exports (`productShortcode`, `ProductShortcode`, ...) are
// generated from the entity registry; ~150 sites import them by name.
export * from "./generated/shortcode-named.gen";
export { SHORTCODE_TYPES, type ShortcodeFor } from "./shortcode-schema";

/** Any entity's shortcode, for surfaces that hold a code before resolving it. */
export type AnyShortcode = z.infer<(typeof SHORTCODE_SCHEMA)[ShortcodeType]>;

type ShortcodeFromPrefix<S extends string> = S extends unknown
  ?
      | {
          [
            T in ShortcodeType
          ]: Uppercase<S> extends `${(typeof SHORTCODE_PREFIX)[T]}${string}`
            ? ShortcodeFor<T>
            : never;
        }[ShortcodeType]
      | {
          [
            P in keyof typeof LEGACY_SHORTCODE_PREFIX
          ]: Uppercase<S> extends `${P}${string}`
            ? ShortcodeFor<(typeof LEGACY_SHORTCODE_PREFIX)[P]>
            : never;
        }[keyof typeof LEGACY_SHORTCODE_PREFIX]
  : never;

// Fall back per input member so a normalized member cannot disappear from a
// literal union and leave the result branded as a different entity.
type ShortcodeFromInput<S extends string> = S extends unknown
  ? [ShortcodeFromPrefix<S>] extends [never]
    ? AnyShortcode
    : ShortcodeFromPrefix<S>
  : never;

/**
 * Validate a code without repeating its entity. Canonical and legacy literals
 * infer their brand from the generated prefix registry, ignoring case. A runtime
 * string (or a literal with surrounding whitespace) retains the entity union.
 * Use an entity schema when the caller requires one particular entity.
 */
export function shortcode<const S extends string>(
  code: S,
): ShortcodeFromInput<S>;
export function shortcode(code: string): AnyShortcode {
  const parsed = parseShortcode(code);
  if (!parsed) throw new Error(`Invalid shortcode: ${code}`);
  return parsed.shortcode;
}

const shortcodeBody = customAlphabet(SHORTCODE_CHARS, SHORTCODE_BODY_LENGTH);

/**
 * Generate a shortcode for `type`. Uniqueness is NOT checked here — the DB
 * unique constraint is authoritative; see `generateUniqueShortcode`.
 */
export function generateShortcode<T extends ShortcodeType>(
  type: T,
): ShortcodeFor<T>;
export function generateShortcode(type: ShortcodeType): AnyShortcode {
  return SHORTCODE_SCHEMA[type].parse(
    `${SHORTCODE_PREFIX[type]}${shortcodeBody(SHORTCODE_LENGTH[type] ?? SHORTCODE_BODY_LENGTH)}`,
  );
}

interface ParsedShortcodeFor<T extends ShortcodeType> {
  type: T;
  /** Always the canonical form, even when `code` used a legacy prefix. */
  shortcode: ShortcodeFor<T>;
}

/**
 * A parsed public identifier whose entity discriminator and branded value stay
 * correlated. Narrowing `type` therefore narrows `shortcode` too.
 */
export type ParsedShortcode = {
  [T in ShortcodeType]: ParsedShortcodeFor<T>;
}[ShortcodeType];

const parsedShortcodeFields = z.object({
  type: z.string(),
  shortcode: z.string(),
});

/** Validate the dependent pair with the same catalog-derived schema that owns its brand. */
const canonicalParsedShortcode = z.custom<ParsedShortcode>((value) => {
  const pair = parsedShortcodeFields.safeParse(value);
  if (!pair.success || !isShortcodeType(pair.data.type)) return false;
  const code = SHORTCODE_SCHEMA[pair.data.type].safeParse(pair.data.shortcode);
  // ZodString normalization is allowed for ordinary input, but this pair promises
  // its value is already canonical as well as belonging to its discriminator.
  return code.success && code.data === pair.data.shortcode;
});

/**
 * Parse a shortcode into its entity type and canonical form, accepting both
 * canonical (`PRD-4K7M`) and legacy (`P-4K7M`) prefixes, in any case, with
 * surrounding whitespace.
 *
 * Splits at the first dash and looks the prefix up in a closed set rather than
 * matching one alternation regex — unambiguous however many prefixes exist, and
 * it can't be fooled by a prefix that happens to be a substring of another.
 */
export function parseShortcode(code: string): ParsedShortcode | null {
  const normalized = code.trim().toUpperCase();
  const dash = normalized.indexOf("-");
  if (dash <= 0) return null;

  const prefix = normalized.slice(0, dash + 1);
  const type = isLegacyPrefix(prefix)
    ? LEGACY_SHORTCODE_PREFIX[prefix]
    : PREFIX_TO_TYPE[prefix];
  if (!type) return null;

  const parsed = canonicalParsedShortcode.safeParse({
    type,
    shortcode: `${SHORTCODE_PREFIX[type]}${normalized.slice(dash + 1)}`,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Extract a shortcode from a raw QR code scan value.
 * Handles both raw shortcodes ("LOC-A3F2") and full URLs
 * ("https://cubby.example.com/LOC-A3F2"), including legacy-prefixed labels.
 */
export function extractShortcodeFromScan(
  rawValue: string,
): ParsedShortcode | null {
  const trimmed = rawValue.trim();

  // Try parsing as a raw shortcode first
  const direct = parseShortcode(trimmed);
  if (direct) return direct;

  // Try parsing as a URL and extracting the last path segment
  try {
    const url = new URL(trimmed);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return parseShortcode(lastSegment);
    }
  } catch {
    // Not a valid URL
  }

  return null;
}

/**
 * Build the full URL for a shortcode (used in QR codes).
 * Uses the shortcode directly in the path: /LOC-XXXX or /PRD-XXXX
 */
export function getShortcodeUrl(shortcode: string): string {
  return `https://cubby.nickysemenza.com/${shortcode}`;
}

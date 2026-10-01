import { customAlphabet } from "nanoid";
import { z } from "zod";
import {
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_BODY_PATTERN,
  SHORTCODE_CHARS,
} from "./shortcode-alphabet";
import { SHORTCODE_SCHEMA, type ShortcodeFor } from "./shortcode-schema";

export {
  LEGACY_SHORTCODE_BODY_LENGTH,
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_BODY_PATTERN,
  SHORTCODE_CHARS,
} from "./shortcode-alphabet";
import {
  SHORTCODE_PREFIX,
  type ShortcodeType,
} from "./generated/shortcode-registry.gen";

export {
  SHORTCODE_PREFIX,
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
 * `pair`) or read off the prefix itself (`image.attach_files`).
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
        `^(?:${types.map((t) => SHORTCODE_PREFIX[t]).join("|")})${SHORTCODE_BODY_PATTERN}$`,
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
    `${SHORTCODE_PREFIX[type]}${shortcodeBody()}`,
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

/**
 * One parser closure per entity, each typed to return its own
 * `ParsedShortcodeFor<T>`. Indexing the table with a union key and calling
 * the result yields the distributed union `ParsedShortcode`; a single generic
 * function would return `ParsedShortcodeFor<ShortcodeType>` — two independent
 * unions — and lose the discriminated-union guarantee. Guarded by the
 * type-level test in shortcode.unit.test.ts.
 */
const shortcodeParser =
  <T extends ShortcodeType>(type: T) =>
  (code: string): ParsedShortcodeFor<T> | null => {
    try {
      return { type, shortcode: parseShortcodeFor(type, code) };
    } catch {
      return null;
    }
  };

/**
 * One parser per entity, each keyed by its own literal so the compiler can
 * verify that `PARSE_CANONICAL_SHORTCODE[type]` returns `ParsedShortcodeFor`
 * of that exact type. Indexing with a union key and calling the result yields
 * the distributed union `ParsedShortcode`; a single generic call with a union
 * argument would return `ParsedShortcodeFor<ShortcodeType>` — two independent
 * unions — and a map built by `mapRecord` would need a cast into a branded
 * type, which the unsafe-identifier guard rightly rejects. So this stays a
 * literal-keyed list; `satisfies` fails to compile when an entity is missing.
 */
const PARSE_CANONICAL_SHORTCODE = {
  spendingCategory: shortcodeParser("spendingCategory"),
  cookbook: shortcodeParser("cookbook"),
  expense: shortcodeParser("expense"),
  financialAccount: shortcodeParser("financialAccount"),
  financialTransaction: shortcodeParser("financialTransaction"),
  image: shortcodeParser("image"),
  ingredient: shortcodeParser("ingredient"),
  inventory: shortcodeParser("inventory"),
  ledgerParty: shortcodeParser("ledgerParty"),
  ledgerTransfer: shortcodeParser("ledgerTransfer"),
  location: shortcodeParser("location"),
  meal: shortcodeParser("meal"),
  planting: shortcodeParser("planting"),
  gardenEntry: shortcodeParser("gardenEntry"),
  product: shortcodeParser("product"),
  productCategory: shortcodeParser("productCategory"),
  project: shortcodeParser("project"),
  purchase: shortcodeParser("purchase"),
  recipe: shortcodeParser("recipe"),
  task: shortcodeParser("task"),
  vendor: shortcodeParser("vendor"),
  vendorAccount: shortcodeParser("vendorAccount"),
  run: shortcodeParser("run"),
  wish: shortcodeParser("wish"),
  device: shortcodeParser("device"),
  plant: shortcodeParser("plant"),
} as const satisfies {
  [T in ShortcodeType]: (code: string) => ParsedShortcodeFor<T> | null;
};

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

  return PARSE_CANONICAL_SHORTCODE[type](
    `${SHORTCODE_PREFIX[type]}${normalized.slice(dash + 1)}`,
  );
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

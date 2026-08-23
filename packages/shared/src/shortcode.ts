import { customAlphabet } from "nanoid";
import { z } from "zod";

/**
 * Character set: 31 chars — the digits and uppercase letters minus the
 * scan/OCR-confusable ones (0/O, 1/I/L). Four of them give 31^4 = 923,521
 * codes per prefix, against a largest table of ~1,800 rows.
 */
export const SHORTCODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const BODY_PATTERN = `[${SHORTCODE_CHARS}]{4}`;
const BODY_RE = new RegExp(`^${BODY_PATTERN}$`);

/**
 * Per-entity shortcode prefixes — the single source of truth for the "XXX-"
 * stamp. Keys match the `Entity` union in `@cubby/schemas/entity` (checked by
 * the entity-manifest drift test); everything below (the schemas, the parser,
 * the generator) derives from this, so a prefix is defined exactly once.
 *
 * Three letters throughout, so a code is self-describing when spoken, typed, or
 * pasted into an agent. `image` is included: it was the last local-table
 * holdout, addressed by raw uuid, which made it a permanent carve-out in every
 * shape that could name an entity — so it was given `IMG-` rather than kept as
 * an exception.
 */
export const SHORTCODE_PREFIX = {
  cookbook: "CKB-",
  expense: "EXP-",
  financialAccount: "FAC-",
  financialTransaction: "FTX-",
  image: "IMG-",
  ingredient: "ING-",
  inventory: "INV-",
  location: "LOC-",
  meal: "MEL-",
  person: "PER-",
  product: "PRD-",
  project: "PRJ-",
  purchase: "PUR-",
  recipe: "RCP-",
  task: "TSK-",
  vendor: "VEN-",
  wish: "WSH-",
} as const;
export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;

/**
 * The single-letter prefixes minted before the 2026-07 cutover, kept forever so
 * physical QR labels already stuck to shelves and products keep resolving.
 *
 * INBOUND ONLY. Nothing emits these — `parseShortcode` rewrites a legacy code to
 * its canonical form, which is possible precisely because the cutover preserved
 * each code's 4-char body (`P-4K7M` became `PRD-4K7M`). That is also why no alias
 * table is needed: the mapping is a pure prefix swap.
 */
export const LEGACY_SHORTCODE_PREFIX = {
  "L-": "location",
  "P-": "product",
  "R-": "recipe",
} as const satisfies Record<string, ShortcodeType>;

const PREFIX_TO_TYPE = Object.fromEntries(
  (Object.keys(SHORTCODE_PREFIX) as ShortcodeType[]).map((type) => [
    SHORTCODE_PREFIX[type],
    type,
  ]),
) as Record<string, ShortcodeType | undefined>;

const LEGACY_TO_TYPE: Record<string, ShortcodeType | undefined> =
  LEGACY_SHORTCODE_PREFIX;

const shortcodeRegex = (type: ShortcodeType) =>
  new RegExp(`^${SHORTCODE_PREFIX[type]}${BODY_PATTERN}$`);

/**
 * A schema for a code whose entity isn't known until runtime — an MCP tool
 * whose target type is chosen by another field (`find_similar_entities`'s
 * `pair`) or read off the prefix itself (`attach_file`).
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
        `^(?:${types.map((t) => SHORTCODE_PREFIX[t]).join("|")})${BODY_PATTERN}$`,
      ),
      `Expected one of: ${types.map((t) => `${SHORTCODE_PREFIX[t]}…`).join(", ")}`,
    );

/**
 * The one schema per entity: it normalizes, validates, brands, AND publishes a
 * useful JSON Schema. There is deliberately no second "normalized" variant.
 *
 * `.trim()`/`.toUpperCase()` are ZodString-level checks, so this stays a
 * `ZodString` rather than becoming a `ZodPipe`. That matters: `z.toJSONSchema`
 * renders a pipe's input side as a bare `{"type":"string"}`, which would strip
 * the `pattern` and `description` that MCP advertises to agents — the prefix
 * hint is most of what makes a shortcode self-explanatory over the wire. The
 * regex is case-SENSITIVE on purpose so the advertised pattern describes the
 * canonical form exactly; the leniency comes from `.toUpperCase()` running
 * first. Guarded by shortcode.unit.test.ts.
 */
const makeShortcodeSchema = <T extends ShortcodeType, B extends string>(
  type: T,
  brand: B,
) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(shortcodeRegex(type), {
      // Name the offending value: a shortcode is something a human read off a
      // label or an agent copied from an earlier response, so "which code was
      // wrong" is the whole useful content of the failure.
      error: (issue) =>
        `Invalid ${type} shortcode: ${String(issue.input)} (expected ${SHORTCODE_PREFIX[type]}XXXX)`,
    })
    .describe(`${type} shortcode, e.g. ${SHORTCODE_PREFIX[type]}4K7M`)
    .brand<B>(brand);

export const cookbookShortcode = makeShortcodeSchema(
  "cookbook",
  "CookbookShortcode",
);
export const expenseShortcode = makeShortcodeSchema(
  "expense",
  "ExpenseShortcode",
);
export const financialAccountShortcode = makeShortcodeSchema(
  "financialAccount",
  "FinancialAccountShortcode",
);
export const financialTransactionShortcode = makeShortcodeSchema(
  "financialTransaction",
  "FinancialTransactionShortcode",
);
export const ingredientShortcode = makeShortcodeSchema(
  "ingredient",
  "IngredientShortcode",
);
export const inventoryShortcode = makeShortcodeSchema(
  "inventory",
  "InventoryShortcode",
);
export const imageShortcode = makeShortcodeSchema("image", "ImageShortcode");
export const locationShortcode = makeShortcodeSchema(
  "location",
  "LocationShortcode",
);
export const mealShortcode = makeShortcodeSchema("meal", "MealShortcode");
export const personShortcode = makeShortcodeSchema("person", "PersonShortcode");
export const productShortcode = makeShortcodeSchema(
  "product",
  "ProductShortcode",
);
export const projectShortcode = makeShortcodeSchema(
  "project",
  "ProjectShortcode",
);
export const purchaseShortcode = makeShortcodeSchema(
  "purchase",
  "PurchaseShortcode",
);
export const recipeShortcode = makeShortcodeSchema("recipe", "RecipeShortcode");
export const taskShortcode = makeShortcodeSchema("task", "TaskShortcode");
export const vendorShortcode = makeShortcodeSchema("vendor", "VendorShortcode");
export const wishShortcode = makeShortcodeSchema("wish", "WishShortcode");

/** Every shortcode schema, keyed by entity — the lookup behind `shortcodeSchema`. */
const SHORTCODE_SCHEMA = {
  cookbook: cookbookShortcode,
  expense: expenseShortcode,
  financialAccount: financialAccountShortcode,
  financialTransaction: financialTransactionShortcode,
  image: imageShortcode,
  ingredient: ingredientShortcode,
  inventory: inventoryShortcode,
  location: locationShortcode,
  meal: mealShortcode,
  person: personShortcode,
  product: productShortcode,
  project: projectShortcode,
  purchase: purchaseShortcode,
  recipe: recipeShortcode,
  task: taskShortcode,
  vendor: vendorShortcode,
  wish: wishShortcode,
} as const satisfies Record<ShortcodeType, unknown>;

/**
 * The shortcode schema for an entity, preserving its exact branded type through
 * the generic lookup. Lets a generic surface (the MCP CRUD toolset, a route
 * param) ask for "this entity's public id schema" without a switch.
 */
export const shortcodeSchema = <T extends ShortcodeType>(
  type: T,
): (typeof SHORTCODE_SCHEMA)[T] => SHORTCODE_SCHEMA[type];

export type CookbookShortcode = z.infer<typeof cookbookShortcode>;
export type ExpenseShortcode = z.infer<typeof expenseShortcode>;
export type FinancialAccountShortcode = z.infer<
  typeof financialAccountShortcode
>;
export type FinancialTransactionShortcode = z.infer<
  typeof financialTransactionShortcode
>;
export type ImageShortcode = z.infer<typeof imageShortcode>;
export type IngredientShortcode = z.infer<typeof ingredientShortcode>;
export type InventoryShortcode = z.infer<typeof inventoryShortcode>;
export type LocationShortcode = z.infer<typeof locationShortcode>;
export type MealShortcode = z.infer<typeof mealShortcode>;
export type PersonShortcode = z.infer<typeof personShortcode>;
export type ProductShortcode = z.infer<typeof productShortcode>;
export type ProjectShortcode = z.infer<typeof projectShortcode>;
export type PurchaseShortcode = z.infer<typeof purchaseShortcode>;
export type RecipeShortcode = z.infer<typeof recipeShortcode>;
export type TaskShortcode = z.infer<typeof taskShortcode>;
export type VendorShortcode = z.infer<typeof vendorShortcode>;
export type WishShortcode = z.infer<typeof wishShortcode>;

/** Any entity's shortcode, for surfaces that hold a code before resolving it. */
export type AnyShortcode = z.infer<(typeof SHORTCODE_SCHEMA)[ShortcodeType]>;

const shortcodeBody = customAlphabet(SHORTCODE_CHARS, 4);

/**
 * Generate a shortcode for `type`. Uniqueness is NOT checked here — the DB
 * unique constraint is authoritative; see `generateUniqueShortcode`.
 */
export function generateShortcode(type: ShortcodeType): string {
  return `${SHORTCODE_PREFIX[type]}${shortcodeBody()}`;
}

export interface ParsedShortcode {
  type: ShortcodeType;
  /** Always the canonical form, even when `code` used a legacy prefix. */
  shortcode: string;
  /** Just the 4-char body ("4K7M"), shared between legacy and canonical forms. */
  id: string;
  /** Whether `code` arrived with a legacy single-letter prefix. */
  legacy: boolean;
}

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
  const body = normalized.slice(dash + 1);
  if (!BODY_RE.test(body)) return null;

  const legacyType = LEGACY_TO_TYPE[prefix];
  const type = legacyType ?? PREFIX_TO_TYPE[prefix];
  if (!type) return null;

  return {
    type,
    shortcode: `${SHORTCODE_PREFIX[type]}${body}`,
    id: body,
    legacy: legacyType !== undefined,
  };
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

import { customAlphabet } from "nanoid";
import { z } from "zod";
import { mapRecord, recordKeys } from "./record";
import { capitalize } from "./text-case";
import { SHORTCODE_BODY_LENGTH, SHORTCODE_CHARS } from "./shortcode-alphabet";

export { SHORTCODE_BODY_LENGTH, SHORTCODE_CHARS } from "./shortcode-alphabet";
import {
  SHORTCODE_PREFIX,
  type ShortcodeType,
} from "./generated/shortcode-registry.gen";

export {
  SHORTCODE_PREFIX,
  type ShortcodeType,
} from "./generated/shortcode-registry.gen";

const BODY_PATTERN = `[${SHORTCODE_CHARS}]{${SHORTCODE_BODY_LENGTH}}`;
const BODY_RE = new RegExp(`^${BODY_PATTERN}$`);

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

const shortcodeRegex = (type: ShortcodeType) =>
  new RegExp(`^${SHORTCODE_PREFIX[type]}${BODY_PATTERN}$`);

/**
 * A schema for a code whose entity isn't known until runtime — an MCP tool
 * whose target type is chosen by another field (`find_similar_entities`'s
 * `pair`) or read off the prefix itself (`attach_files`).
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

/** Every shortcode entity, in generated-registry order. */
export const SHORTCODE_TYPES: readonly ShortcodeType[] =
  recordKeys(SHORTCODE_PREFIX);

/** The Zod brand an entity's shortcode schema carries: `product` → `ProductShortcode`. */
type ShortcodeBrand<T extends ShortcodeType> = `${Capitalize<T>}Shortcode`;

const shortcodeBrand = <T extends ShortcodeType>(type: T): ShortcodeBrand<T> =>
  `${capitalize(type)}Shortcode`;

type ShortcodeSchemaFor<T extends ShortcodeType> = ReturnType<
  typeof makeShortcodeSchema<T, ShortcodeBrand<T>>
>;

/**
 * Every shortcode schema, keyed by entity — the lookup behind `shortcodeSchema`
 * and the per-entity exports below. Built from the generated prefix registry,
 * so a new entity gets its schema (and brand) without a line here.
 */
type ShortcodeSchemaMap = { [T in ShortcodeType]: ShortcodeSchemaFor<T> };
// SAFETY: each entry is `makeShortcodeSchema(type, brand(type))` for its own
// key, i.e. exactly `ShortcodeSchemaFor<type>`; the builder's `.brand<B>()` is
// a deferred conditional inside a generic closure, so the compiler cannot
// prove the per-key correlation this construction guarantees.
// shortcode.unit.test.ts asserts it per entity at the type level.
const SHORTCODE_SCHEMA = mapRecord(SHORTCODE_TYPES, (type) =>
  makeShortcodeSchema(type, shortcodeBrand(type)),
) as ShortcodeSchemaMap;

/**
 * The shortcode schema for an entity, preserving its exact branded type through
 * the generic lookup. Lets a generic surface (the MCP CRUD toolset, a route
 * param) ask for "this entity's public id schema" without a switch.
 */
export const shortcodeSchema = <T extends ShortcodeType>(
  type: T,
): (typeof SHORTCODE_SCHEMA)[T] => SHORTCODE_SCHEMA[type];

/** The branded public identifier for one exact entity. */
export type ShortcodeFor<T extends ShortcodeType> = z.infer<
  (typeof SHORTCODE_SCHEMA)[T]
>;

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

// Named per-entity exports over the same map. These are the stable import
// surface (>150 sites name `productShortcode` / `ProductShortcode`); each is
// the map entry, never a second `makeShortcodeSchema` call.
export const cookbookShortcode = SHORTCODE_SCHEMA.cookbook;
export const expenseShortcode = SHORTCODE_SCHEMA.expense;
export const financialAccountShortcode = SHORTCODE_SCHEMA.financialAccount;
export const financialTransactionShortcode =
  SHORTCODE_SCHEMA.financialTransaction;
export const imageShortcode = SHORTCODE_SCHEMA.image;
export const ingredientShortcode = SHORTCODE_SCHEMA.ingredient;
export const inventoryShortcode = SHORTCODE_SCHEMA.inventory;
export const ledgerPartyShortcode = SHORTCODE_SCHEMA.ledgerParty;
export const ledgerTransferShortcode = SHORTCODE_SCHEMA.ledgerTransfer;
export const locationShortcode = SHORTCODE_SCHEMA.location;
export const mealShortcode = SHORTCODE_SCHEMA.meal;
export const plantingShortcode = SHORTCODE_SCHEMA.planting;
export const gardenEntryShortcode = SHORTCODE_SCHEMA.gardenEntry;
export const productCategoryShortcode = SHORTCODE_SCHEMA.productCategory;
export const productShortcode = SHORTCODE_SCHEMA.product;
export const projectShortcode = SHORTCODE_SCHEMA.project;
export const purchaseShortcode = SHORTCODE_SCHEMA.purchase;
export const recipeShortcode = SHORTCODE_SCHEMA.recipe;
export const taskShortcode = SHORTCODE_SCHEMA.task;
export const vendorShortcode = SHORTCODE_SCHEMA.vendor;
export const vendorAccountShortcode = SHORTCODE_SCHEMA.vendorAccount;
export const wishShortcode = SHORTCODE_SCHEMA.wish;

export type CookbookShortcode = ShortcodeFor<"cookbook">;
export type ExpenseShortcode = ShortcodeFor<"expense">;
export type FinancialAccountShortcode = ShortcodeFor<"financialAccount">;
export type FinancialTransactionShortcode =
  ShortcodeFor<"financialTransaction">;
export type ImageShortcode = ShortcodeFor<"image">;
export type IngredientShortcode = ShortcodeFor<"ingredient">;
export type InventoryShortcode = ShortcodeFor<"inventory">;
export type LedgerPartyShortcode = ShortcodeFor<"ledgerParty">;
export type LedgerTransferShortcode = ShortcodeFor<"ledgerTransfer">;
export type LocationShortcode = ShortcodeFor<"location">;
export type MealShortcode = ShortcodeFor<"meal">;
export type PlantingShortcode = ShortcodeFor<"planting">;
export type GardenEntryShortcode = ShortcodeFor<"gardenEntry">;
export type ProductCategoryShortcode = ShortcodeFor<"productCategory">;
export type ProductShortcode = ShortcodeFor<"product">;
export type ProjectShortcode = ShortcodeFor<"project">;
export type PurchaseShortcode = ShortcodeFor<"purchase">;
export type RecipeShortcode = ShortcodeFor<"recipe">;
export type TaskShortcode = ShortcodeFor<"task">;
export type VendorShortcode = ShortcodeFor<"vendor">;
export type VendorAccountShortcode = ShortcodeFor<"vendorAccount">;
export type WishShortcode = ShortcodeFor<"wish">;

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
  (code: string): ParsedShortcodeFor<T> => ({
    type,
    shortcode: parseShortcodeFor(type, code),
  });

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
  wish: shortcodeParser("wish"),
} as const satisfies {
  [T in ShortcodeType]: (code: string) => ParsedShortcodeFor<T>;
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
  const body = normalized.slice(dash + 1);
  if (!BODY_RE.test(body)) return null;

  const type = isLegacyPrefix(prefix)
    ? LEGACY_SHORTCODE_PREFIX[prefix]
    : PREFIX_TO_TYPE[prefix];
  if (!type) return null;

  return PARSE_CANONICAL_SHORTCODE[type](`${SHORTCODE_PREFIX[type]}${body}`);
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

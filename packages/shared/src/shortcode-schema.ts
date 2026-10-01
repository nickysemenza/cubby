import { z } from "zod";
import { mapRecord, recordKeys } from "./record";
import { capitalize } from "./text-case";
import { SHORTCODE_BODY_PATTERN } from "./shortcode-alphabet";
import {
  SHORTCODE_PREFIX,
  type ShortcodeType,
} from "./generated/shortcode-registry.gen";

const shortcodeRegex = (type: ShortcodeType) =>
  new RegExp(`^${SHORTCODE_PREFIX[type]}${SHORTCODE_BODY_PATTERN}$`);

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
        `Invalid ${type} shortcode: ${String(issue.input)} (expected ${SHORTCODE_PREFIX[type]}XXXX or ${SHORTCODE_PREFIX[type]}XXXXX)`,
    })
    .describe(`${type} shortcode, e.g. ${SHORTCODE_PREFIX[type]}4K7MN`)
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
export { SHORTCODE_SCHEMA };

/** The branded public identifier for one exact entity. */
export type ShortcodeFor<T extends ShortcodeType> = z.infer<
  (typeof SHORTCODE_SCHEMA)[T]
>;

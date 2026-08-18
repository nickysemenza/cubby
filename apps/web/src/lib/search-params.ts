import { z } from "zod";

/**
 * A search param that should reach the app as a string.
 *
 * **Use this instead of `z.string().optional().catch(undefined)` in any
 * route's `validateSearch`.** The plain-string version has a silent hole:
 * TanStack Router's default `parseSearch` JSON-parses every param, so a value
 * that happens to be a valid JSON token arrives as that token's TYPE, not as a
 * string —
 *
 *   - `?q=486242`      → the number `486242`
 *   - `?order=11334`   → the number `11334`
 *   - `?future=true`   → the boolean `true`
 *
 * — and `z.string()` then rejects it straight into `.catch(undefined)`. The
 * param vanishes with no error and no filter chip, leaving an unfiltered view
 * that reads as a real answer. That's the worst shape a bug can take here: the
 * page looks like it worked.
 *
 * None of these are hypothetical. Vendor order ids are routinely all digits
 * (Tool Nirvana `11334`, Lowe's `300902141253424770`), so are the SKUs people
 * search the ledger for, and the `future` filter's own option values are the
 * literal strings `"true"` / `"false"`.
 *
 * Writes are unaffected either way — the router's stringifier quotes ambiguous
 * values on the way out (`?order=%2211334%22`), so links built by
 * `<Link search>` already round-trip. This covers the URL a person types,
 * tidies by hand, pastes from a receipt, or copies out of a bug report.
 *
 * Params that are genuinely non-string (a real `z.boolean()` flag like
 * `?create=true`, or `page`/`pageSize` numbers) should stay typed as
 * themselves — this is only for values the app wants back as strings.
 *
 * **Known limit:** an all-digits value longer than ~15 digits has already lost
 * precision by the time this schema runs — `JSON.parse` rounds it to the
 * nearest double, turning Lowe's `300902141253424770` into
 * `300902141253424800`. That's unrecoverable here, so those are REJECTED
 * (dropped by `.catch`) rather than coerced: filtering on an id the user never
 * typed would return a confidently empty result, which is worse than an
 * obviously-missing filter. Links are unaffected — `<Link search>` quotes the
 * value, and a quoted param never reaches the number branch at all.
 */
const losslessNumber = z
  .number()
  .refine((n) => !Number.isInteger(n) || Number.isSafeInteger(n));

export const urlStringParam = z
  .union([z.string(), losslessNumber, z.boolean()])
  .transform(String)
  .optional()
  .catch(undefined);

/** A comma-encoded, one-or-many enum filter that retains URL string coercion. */
export const urlEnumListParam = <T extends z.ZodType<string>>(itemSchema: T) =>
  urlStringParam.refine(
    (value) =>
      value === undefined ||
      value
        .split(",")
        .every((item) => item.length > 0 && itemSchema.safeParse(item).success),
    "Invalid filter value",
  );

const SHORTCODE_SUFFIX = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

/** A canonical, comma-encoded exact-entity filter without a domain import. */
export const urlShortcodeListParam = (prefix: string) =>
  urlStringParam
    .transform((value) => value?.toUpperCase())
    .refine(
      (value) =>
        value === undefined ||
        value.split(",").every((item) => {
          const [actualPrefix, suffix, extra] = item.split("-");
          return (
            extra === undefined &&
            actualPrefix === prefix &&
            suffix !== undefined &&
            SHORTCODE_SUFFIX.test(suffix)
          );
        }),
      "Invalid entity shortcode filter",
    );

/** A single exact shortcode scope (not a multi-select). */
export const urlShortcodeParam = (prefix: string) =>
  urlShortcodeListParam(prefix).refine(
    (value) => value === undefined || !value.includes(","),
    "Expected one entity shortcode",
  );

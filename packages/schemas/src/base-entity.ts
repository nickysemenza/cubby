import { RELATIVE_DATE_PATTERN } from "@cubby/shared";
import { z } from "zod";
import { dateTime } from "./codec";

/**
 * Shared building blocks for entity schemas, so the fields every entity carries
 * are defined once instead of re-declared per module.
 *
 * These are raw field *maps* (spreadable into `z.object({...})`), not pre-wrapped
 * schemas — the schema modules already standardize on the "object spread + add a
 * few fields" idiom (`productTopLevelFields`, `locationOutFields`, …), and a field
 * map composes with per-entity overrides while still letting `z.object(fields)`
 * build the many derived shapes. Spread them where the entity already places the
 * corresponding keys so field order (and the API contract) is preserved.
 */

export const timestampedFields = {
  createdAt: dateTime,
  updatedAt: dateTime,
} as const;

/**
 * A calendar day as a plain "YYYY-MM-DD" string, timezone-free.
 *
 * The one canonical definition — `mealDate` (meal-shared.ts) and `auditDate`
 * (below) alias this rather than re-declaring the same regex.
 */
export const plainDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .meta({ mockValue: "2024-01-15" })
  .describe('Calendar day as "YYYY-MM-DD"');

/**
 * A date range filter bound: a calendar day, or a relative date token
 * (`@today`, `@today-30d`) the entity kernel resolves to the household's
 * day before a repository runs (#2415).
 */
export const dateBound = z
  .string()
  .regex(
    new RegExp(
      `^(?:\\d{4}-\\d{2}-\\d{2}|${RELATIVE_DATE_PATTERN.source.slice(1, -1)})$`,
    ),
    'expected YYYY-MM-DD or "@today", "@today-Nd", "@today+Nd"',
  )
  .meta({ mockValue: "2024-01-15" })
  .describe(
    'Calendar day as "YYYY-MM-DD", or the household\'s today as "@today", "@today-Nd" or "@today+Nd" (N whole days)',
  );

type DateRangeFields<Prefix extends string> = {
  [K in `${Prefix}From`]: z.ZodOptional<typeof dateBound>;
} & {
  [K in `${Prefix}To`]: z.ZodOptional<typeof dateBound>;
};

/**
 * Inclusive `{prefix}From`/`{prefix}To` calendar-day filter bounds. Same
 * generator shape as `trio()` in related-view.ts — a spreadable field-map
 * factory — specialized to the date-range-pair pattern instead of the
 * relation-filter-triple one.
 *
 * Covers the optional pair, with `opts.describe` for the MCP prose each
 * bound carries. A pair that isn't optional (an output shape's resolved
 * range, not a filter) is a deliberate divergence, not an oversight — leave
 * it hand-declared rather than forcing it through this generator.
 */
export const dateRangeFields = <Prefix extends string>(
  prefix: Prefix,
  opts?: { describe?: { from: string; to: string } },
): DateRangeFields<Prefix> => {
  const bound = dateBound.optional();
  const describe = opts?.describe;
  // SAFETY: the two computed keys are derived from the same Prefix used by the
  // return type, and both values are the shared optional date-bound schema.
  return {
    [`${prefix}From`]: describe ? bound.describe(describe.from) : bound,
    [`${prefix}To`]: describe ? bound.describe(describe.to) : bound,
  } as DateRangeFields<Prefix>;
};

export const auditDateFilterFields = {
  ...dateRangeFields("created"),
  ...dateRangeFields("updated"),
} as const;

type NumericRangeFields<Prefix extends string> = {
  [K in `${Prefix}Min`]: z.ZodOptional<z.ZodNumber>;
} & {
  [K in `${Prefix}Max`]: z.ZodOptional<z.ZodNumber>;
};

/**
 * Inclusive `{prefix}Min`/`{prefix}Max` numeric filter bounds. Same generator
 * shape as `dateRangeFields` above — a spreadable field-map factory —
 * specialized to the numeric-range-pair pattern instead of the calendar-day
 * one.
 *
 * `opts.coerce` defaults to `true`: these arrive from the URL as strings
 * (`?costMin=500`), and a bare `z.number()` rejects `"500"`. Pass
 * `coerce: false` for a field that is never bound from a URL query string
 * (e.g. an MCP-only filter already typed as a number).
 *
 * Only covers the plain, undecorated pair with a shared set of numeric
 * constraints on both ends. A pair whose bounds carry DIFFERENT `.describe()`
 * prose is still coverable via `opts.describe`, but a pair that isn't
 * optional, isn't a Min/Max pair at all (a singleton bound with no other
 * end), or layers on a constraint the options bag doesn't express (e.g.
 * `.positive().max(...)`) is a deliberate divergence, not an oversight —
 * leave those hand-declared rather than forcing them through this generator.
 */
export const numericRangeFields = <Prefix extends string>(
  prefix: Prefix,
  opts?: {
    int?: boolean;
    nonnegative?: boolean;
    finite?: boolean;
    coerce?: boolean;
    describe?: { min: string; max: string };
  },
): NumericRangeFields<Prefix> => {
  const { int, nonnegative, finite, coerce = true, describe } = opts ?? {};
  let base: z.ZodNumber = coerce ? z.coerce.number() : z.number();
  if (int) base = base.int();
  if (nonnegative) base = base.nonnegative();
  if (finite) base = base.finite();
  const min = base.optional();
  const max = base.optional();
  // SAFETY: both computed keys are derived from Prefix and each value is the
  // optional numeric schema built from the same constrained base.
  return {
    [`${prefix}Min`]: describe ? min.describe(describe.min) : min,
    [`${prefix}Max`]: describe ? max.describe(describe.max) : max,
  } as NumericRangeFields<Prefix>;
};

/**
 * `.refine()` args for an array that must not contain duplicate `keyFn(item)`
 * values — spread into `.refine(...uniqueBy(keyFn, message))`. `keyFn` is the
 * identity function for a raw array of comparable values, or a field accessor
 * (e.g. `(row) => row.key`) for an array of objects deduped by one field.
 */
type UniqueKey = string | number | boolean | bigint | symbol | null | undefined;

export function uniqueBy<T = UniqueKey>(
  keyFn: (item: T) => UniqueKey,
  message: string,
): [(items: T[]) => boolean, string] {
  return [(items) => new Set(items.map(keyFn)).size === items.length, message];
}

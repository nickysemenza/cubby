import { z } from "zod";

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
  createdAt: z.date(),
  updatedAt: z.date(),
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

type DateRangeFields<Prefix extends string> = {
  [K in `${Prefix}From`]: z.ZodOptional<typeof plainDate>;
} & {
  [K in `${Prefix}To`]: z.ZodOptional<typeof plainDate>;
};

/**
 * Inclusive `{prefix}From`/`{prefix}To` calendar-day filter bounds. Same
 * generator shape as `trio()` in related-view.ts — a spreadable field-map
 * factory — specialized to the date-range-pair pattern instead of the
 * relation-filter-triple one.
 *
 * Only covers the plain, undecorated pair: `plainDate.optional()` on both
 * ends, nothing else. A pair that also carries a `.describe()` (several
 * filter fields do, for MCP tool prose) or that isn't optional (an output
 * shape's resolved range, not a filter) is a deliberate divergence, not an
 * oversight — leave those hand-declared rather than forcing them through
 * this generator and losing the description or the optionality.
 */
export const dateRangeFields = <Prefix extends string>(
  prefix: Prefix,
): DateRangeFields<Prefix> => {
  const bound = plainDate.optional();
  // SAFETY: the two computed keys are derived from the same Prefix used by the
  // return type, and both values are the shared optional plain-date schema.
  return {
    [`${prefix}From`]: bound,
    [`${prefix}To`]: bound,
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

type StripDefault<F> =
  F extends z.ZodDefault<infer Inner extends z.ZodType> ? Inner : F;

type UpdateFields<
  T extends z.ZodRawShape,
  OmitK extends keyof T,
  E extends z.ZodRawShape,
> = {
  [K in Exclude<keyof T, OmitK>]: z.ZodOptional<StripDefault<T[K]>>;
} & E;

/**
 * Derive an UPDATE-data schema from a CREATE shape: every field becomes optional
 * AND any field-level `.default(...)` is stripped first.
 *
 * Stripping the default is the whole point — a partial update must leave an
 * omitted key UNCHANGED. With a naive `.partial()`, a create-time `.default([])`
 * (e.g. `unitMappings`, `externalIds`, `aliases`) survives, so omitting the key on
 * update would coerce it to `[]` and silently wipe the existing rows. This was
 * previously prevented by hand-writing each `xUpdateData`; now it's one helper.
 *
 * @param createFields the raw fields object behind the create schema (`z.object(createFields)`)
 * @param opts.extend update-only fields the create shape lacks (e.g. `removeImageIds`)
 * @param opts.omit  server-managed create fields to drop from the update surface
 */
export function deriveUpdateFields<
  T extends z.ZodRawShape,
  const OmitK extends keyof T = never,
  E extends z.ZodRawShape = Record<never, never>,
>(
  createFields: T,
  opts: { extend?: E; omit?: readonly OmitK[] } = {},
): UpdateFields<T, OmitK, E> {
  const omit = new Set<PropertyKey>(opts.omit ?? []);
  const fields: Record<string, z.core.$ZodType> = {};
  for (const [key, field] of Object.entries(createFields)) {
    if (omit.has(key)) continue;
    const base = field instanceof z.ZodDefault ? field.unwrap() : field;
    fields[key] = z.optional(base);
  }
  Object.assign(fields, opts.extend ?? {});
  // SAFETY: each retained create key is copied with its default removed and
  // made optional; extend contributes exactly E, so this matches UpdateFields.
  return fields as UpdateFields<T, OmitK, E>;
}

export function deriveUpdateData<
  T extends z.ZodRawShape,
  const OmitK extends keyof T = never,
  E extends z.ZodRawShape = Record<never, never>,
>(
  createFields: T,
  opts: { extend?: E; omit?: readonly OmitK[] } = {},
): z.ZodObject<UpdateFields<T, OmitK, E>> {
  const fields = deriveUpdateFields(createFields, opts);
  // SAFETY: deriveUpdateFields constructs exactly the raw shape described by
  // UpdateFields; Zod's object constructor preserves that shape at runtime.
  return z.object(fields) as z.ZodObject<UpdateFields<T, OmitK, E>>;
}

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

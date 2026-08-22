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

/** `createdAt` / `updatedAt` as they appear on every API read shape. */
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
  return {
    [`${prefix}From`]: bound,
    [`${prefix}To`]: bound,
  } as DateRangeFields<Prefix>;
};

export const auditDateFilterFields = {
  ...dateRangeFields("created"),
  ...dateRangeFields("updated"),
} as const;

type StripDefault<F> =
  F extends z.ZodDefault<infer Inner extends z.ZodType> ? Inner : F;

type UpdateShape<
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
 * @param createShape the raw shape object behind the create schema (`z.object(shape)`)
 * @param opts.extend update-only fields the create shape lacks (e.g. `removeImageIds`)
 * @param opts.omit  server-managed create fields to drop from the update surface
 */
export function deriveUpdateFields<
  T extends z.ZodRawShape,
  const OmitK extends keyof T = never,
  E extends z.ZodRawShape = Record<never, never>,
>(
  createShape: T,
  opts: { extend?: E; omit?: readonly OmitK[] } = {},
): UpdateShape<T, OmitK, E> {
  const omit = new Set<keyof T>(opts.omit ?? []);
  const shape: Record<string, z.ZodType> = {};
  const entries = Object.entries(createShape) as [keyof T, z.ZodType][];
  for (const [key, field] of entries) {
    if (omit.has(key)) continue;
    // Strip a field-level `.default(...)` before making it optional, so an
    // omitted key means "leave unchanged" rather than "reset to the default".
    // `.unwrap()` is typed as Zod's core `$ZodType`; the public `z.ZodType` (the
    // one with `.optional()`) is its subtype, hence the single localized cast.
    const base =
      field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field;
    shape[key as string] = base.optional();
  }
  Object.assign(shape, opts.extend ?? {});
  return shape as UpdateShape<T, OmitK, E>;
}

export function deriveUpdateData<
  T extends z.ZodRawShape,
  const OmitK extends keyof T = never,
  E extends z.ZodRawShape = Record<never, never>,
>(
  createShape: T,
  opts: { extend?: E; omit?: readonly OmitK[] } = {},
): z.ZodObject<UpdateShape<T, OmitK, E>> {
  return z.object(deriveUpdateFields(createShape, opts)) as z.ZodObject<
    UpdateShape<T, OmitK, E>
  >;
}

type McpInputShape<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodNullable<infer Inner extends z.ZodType>
    ? z.ZodOptional<z.ZodNullable<Inner>>
    : T[K];
};

/**
 * Mechanically re-derive an MCP write shape from a plain `*CreateShape`
 * sibling: every field that is bare `.nullable()` (nullable but NOT also
 * `.optional()`) becomes `.nullish()`. Every other field passes through
 * unchanged — this does not touch `.describe()` text, add/remove fields, or
 * reorder them.
 *
 * This exists because of one concrete, previously-shipped bug: a bare
 * `.nullable()` field still makes its KEY required, so an MCP client with no
 * value for it (as opposed to an explicit `null`) cannot omit it — that's what
 * made a Product with no UPC uncreatable over MCP (`productCreateShape.upc:
 * gtin.nullable()`; hand-fixed on `mcpProductCreateInput` as
 * `upc: gtin.nullish()`). The narrow scope is deliberate: because it changes
 * nothing else, `toMcpInput(createShape)` only reproduces today's hand-written
 * MCP shape when that shape's field set and prose ALREADY match the plain
 * shape's — an MCP shape that omits fields, adds MCP-only ones, or carries
 * rewritten tool-facing descriptions needs its own hand-written declaration,
 * same as before this helper existed.
 */
export function toMcpInput<T extends z.ZodRawShape>(
  shape: T,
): McpInputShape<T> {
  const result: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape) as [string, z.ZodType][]) {
    result[key] = field instanceof z.ZodNullable ? field.optional() : field;
  }
  return result as McpInputShape<T>;
}

/**
 * `.refine()` args for an array that must not contain duplicate `keyFn(item)`
 * values — spread into `.refine(...uniqueBy(keyFn, message))`. `keyFn` is the
 * identity function for a raw array of comparable values, or a field accessor
 * (e.g. `(row) => row.key`) for an array of objects deduped by one field.
 */
export function uniqueBy<T>(
  keyFn: (item: T) => unknown,
  message: string,
): [(items: T[]) => boolean, string] {
  return [(items) => new Set(items.map(keyFn)).size === items.length, message];
}

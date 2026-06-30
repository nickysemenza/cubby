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
export function deriveUpdateData<
  T extends z.ZodRawShape,
  const OmitK extends keyof T = never,
  E extends z.ZodRawShape = Record<never, never>,
>(
  createShape: T,
  opts: { extend?: E; omit?: readonly OmitK[] } = {},
): z.ZodObject<UpdateShape<T, OmitK, E>> {
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
  return z.object(shape) as z.ZodObject<UpdateShape<T, OmitK, E>>;
}

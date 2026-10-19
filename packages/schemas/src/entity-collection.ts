import { z } from "zod";

/**
 * Collection patching (`entity.update`). A field whose declaration names a
 * `collection` identity key accepts either its full replacement value or a
 * list of patch items addressed by that key:
 *
 * - `add`: insert the item at `key` (attributes in `value`); an item already
 *   present is updated in place, so a retried add is a no-op.
 * - `replace`: change the item at `key`; it must be present.
 * - `remove`: drop the item at `key`; it must be present.
 *
 * `expect` on replace/remove names attributes the present item must still
 * hold. Every precondition is checked before any item changes, so a refused
 * patch changes nothing.
 */
export const COLLECTION_PATCH_OPS = ["add", "replace", "remove"] as const;
export type CollectionPatchOp = (typeof COLLECTION_PATCH_OPS)[number];

/** A collection keyed by its own value (`aliases`, `tags`). One instance, so every field shares its OpenAPI components. */
export const valueCollectionPatch = z
  .array(
    z.discriminatedUnion("op", [
      z
        .strictObject({ op: z.literal("add"), key: z.string() })
        .meta({ id: "ValueCollectionPatchAdd" }),
      z
        .strictObject({
          op: z.literal("replace"),
          key: z.string(),
          value: z.string().describe("The value that replaces `key`."),
        })
        .meta({ id: "ValueCollectionPatchReplace" }),
      z
        .strictObject({ op: z.literal("remove"), key: z.string() })
        .meta({ id: "ValueCollectionPatchRemove" }),
    ]),
  )
  .min(1)
  .describe(
    "Patch items: add, replace (renames `key` to `value`), or remove one value; replace/remove fail when `key` is absent.",
  )
  .meta({ id: "ValueCollectionPatch" });
/** The full list input beneath optional/nullable and ordinary patch unions. */
export function collectionArraySchema(
  schema: z.core.$ZodType | null,
): z.ZodArray | null {
  if (schema instanceof z.ZodArray) return schema;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return collectionArraySchema(schema.unwrap());
  if (schema instanceof z.ZodUnion)
    return (
      schema.options
        .map((option) => collectionArraySchema(option))
        .find((option) => option !== null) ?? null
    );
  return null;
}

/** Bulk lists share ordinary item validation; record identities are normal collection metadata. */
export function bulkCollectionPatchSchema(
  normalField: z.ZodType,
  identity: "value" | readonly string[],
  id: string,
) {
  const array = collectionArraySchema(normalField);
  if (!array)
    throw new Error("A collection patch requires a normal list input");
  const item = array.element;
  if (identity === "value")
    return z
      .array(
        z.discriminatedUnion("op", [
          z
            .strictObject({ op: z.literal("add"), key: item })
            .meta({ id: `${id}Add` }),
          z
            .strictObject({ op: z.literal("remove"), key: item })
            .meta({ id: `${id}Remove` }),
        ]),
      )
      .min(1)
      .meta({ id });
  if (!(item instanceof z.ZodObject))
    throw new Error("A keyed collection requires record items");
  const key = z.strictObject(
    Object.fromEntries(
      identity.map((key) => {
        const rule = item.shape[key];
        if (!rule)
          throw new Error(`Collection identity ${key} is not an item field`);
        return [key, rule];
      }),
    ),
  );
  const value = z.strictObject(
    Object.fromEntries(
      Object.entries(item.shape).filter(([key]) => !identity.includes(key)),
    ),
  );
  return z
    .array(
      z.discriminatedUnion("op", [
        z
          .strictObject({ op: z.literal("add"), key, value })
          .meta({ id: `${id}Add` }),
        z
          .strictObject({ op: z.literal("remove"), key })
          .meta({ id: `${id}Remove` }),
      ]),
    )
    .min(1)
    .meta({ id });
}

/** Preserve ordinary object refinements immediately for scalar edits; patched collections are validated after per-record resolution. */
export const bulkUpdateInputSchema = <const Fields extends z.ZodRawShape>(
  normalUpdate: z.ZodType,
  fieldRules: Fields,
  collectionFields: readonly string[],
) =>
  z.strictObject(fieldRules).superRefine((data, context) => {
    if (collectionFields.some((key) => key in data)) return;
    const parsed = normalUpdate.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue({ ...issue });
    }
  });

export type ValueCollectionPatch = z.infer<typeof valueCollectionPatch>;

/**
 * A collection of records keyed by declared identity fields (`externalIds`).
 * `id` names the OpenAPI components of its items.
 */
export const keyedCollectionPatch = <
  Key extends z.ZodObject,
  Value extends z.ZodObject,
>(
  id: string,
  key: Key,
  value: Value,
) =>
  z
    .array(
      z.discriminatedUnion("op", [
        z
          .strictObject({
            op: z.literal("add"),
            key,
            value: value.optional(),
          })
          .meta({ id: `${id}Add` }),
        z
          .strictObject({
            op: z.literal("replace"),
            key,
            value,
            expect: value.partial().optional(),
          })
          .meta({ id: `${id}Replace` }),
        z
          .strictObject({
            op: z.literal("remove"),
            key,
            expect: value.partial().optional(),
          })
          .meta({ id: `${id}Remove` }),
      ]),
    )
    .min(1);

const patchList = z
  .array(z.looseObject({ op: z.enum(COLLECTION_PATCH_OPS) }))
  .min(1);

/** True for a patch list rather than a full replacement value. */
export const isCollectionPatch = (
  value: unknown,
): value is ReadonlyArray<{ op: CollectionPatchOp }> =>
  patchList.safeParse(value).success;

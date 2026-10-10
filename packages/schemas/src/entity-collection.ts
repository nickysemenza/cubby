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

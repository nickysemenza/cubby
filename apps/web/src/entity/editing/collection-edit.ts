import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { isEqual } from "es-toolkit";
import { z } from "zod";

const rowSchema = z.record(z.string(), z.json());
// Mounted optional form controls register undefined; those leaves carry no edit intent.
const editableRowSchema = z
  .record(z.string(), z.json().optional())
  .transform((row) =>
    Object.fromEntries(
      Object.entries(row).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]],
      ),
    ),
  );
export type CollectionRow = z.infer<typeof rowSchema>;
export const collectionEditSchema = z.object({
  collectionEdit: z.object({
    creating: z.boolean(),
    rows: z.array(
      z.object({
        localKey: z.string(),
        baseline: rowSchema.nullable(),
        value: editableRowSchema.nullable(),
        primaryIntent: z.boolean(),
        replacing: z.boolean(),
      }),
    ),
  }),
});
export type CollectionDraft = z.infer<typeof collectionEditSchema>;
type CollectionMetadata = NonNullable<
  EntityFieldModel["fields"][number]["collection"]
>;
export type CollectionDescriptor = Omit<CollectionMetadata, "key"> & {
  readonly key: Exclude<CollectionMetadata["key"], "value">;
};

/** One form value owns both the immutable saved identities and explicit local row intent. */
export function collectionDraft(
  value: unknown,
  creating: boolean,
): CollectionDraft {
  const parsed = z.array(rowSchema).nullish().parse(value);
  if (parsed == null && !creating)
    throw new Error("Load the saved collection before editing it.");
  const rows = parsed ?? [];
  return {
    collectionEdit: {
      creating,
      rows: rows.map((row) => ({
        baseline: creating ? null : structuredClone(row),
        localKey: crypto.randomUUID(),
        value: row,
        primaryIntent: false,
        replacing: false,
      })),
    },
  };
}

const pick = (row: CollectionRow, keys: readonly string[]): CollectionRow =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = row[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );

/** Converts intent before the ordinary input validator; never sends editor metadata to the wire. */
export function collectionWireValue(
  draft: CollectionDraft,
  {
    descriptor,
    attributes,
    normalize = (row) => row,
  }: {
    descriptor: CollectionDescriptor;
    attributes: readonly string[];
    normalize?: (row: CollectionRow) => CollectionRow;
  },
): z.infer<ReturnType<typeof z.json>>[] {
  const { rows, creating } = draft.collectionEdit;
  const primary = descriptor.primary;
  const active = rows.flatMap((row) =>
    row.value === null ? [] : [{ ...row, value: normalize(row.value) }],
  );
  const identity = (row: CollectionRow) => pick(row, descriptor.key);
  for (const [index, row] of active.entries()) {
    if (
      active
        .slice(0, index)
        .some((other) => isEqual(identity(other.value), identity(row.value)))
    )
      throw new Error(
        "This identifier already exists in the collection. Remove a row explicitly to retire it.",
      );
    const baseline = row.baseline === null ? null : normalize(row.baseline);
    if (
      baseline !== null &&
      !isEqual(identity(baseline), identity(row.value)) &&
      rows.some(
        (other) =>
          other.baseline !== null &&
          isEqual(identity(normalize(other.baseline)), identity(row.value)),
      )
    )
      throw new Error(
        "The replacement target already exists in the saved collection.",
      );
  }
  if (primary) {
    const requests = active.filter((row) => row.primaryIntent);
    if (
      requests.some((row, index) =>
        requests
          .slice(0, index)
          .some((other) =>
            isEqual(
              pick(other.value, primary.scope),
              pick(row.value, primary.scope),
            ),
          ),
      )
    )
      throw new Error("Choose only one primary per source and kind.");
  }
  if (creating) {
    const chosen: CollectionRow[] = [];
    return active.map((row) => {
      if (!primary) return row.value;
      const scope = pick(row.value, primary.scope);
      const explicit = active.find(
        (candidate) =>
          candidate.primaryIntent &&
          isEqual(pick(candidate.value, primary.scope), scope),
      );
      const isPrimary = explicit
        ? explicit === row
        : !chosen.some((other) => isEqual(other, scope));
      chosen.push(scope);
      return { ...row.value, [primary.key]: isPrimary };
    });
  }
  const patches: CollectionRow[] = [];
  for (const row of rows) {
    const before = row.baseline === null ? null : normalize(row.baseline);
    const after = row.value === null ? null : normalize(row.value);
    const changedIdentity =
      before !== null &&
      after !== null &&
      !isEqual(identity(before), identity(after));
    const expect = before === null ? {} : pick(before, attributes);
    if (before && (after === null || changedIdentity))
      patches.push({ op: "remove", key: identity(before), expect });
    if (!after) continue;
    const attrs = pick(after, attributes);
    if (primary) {
      delete attrs[primary.key];
      if (row.primaryIntent) attrs[primary.key] = true;
      else if (changedIdentity && before)
        attrs[primary.key] = active.some(
          (other) =>
            other.primaryIntent &&
            isEqual(
              pick(other.value, primary.scope),
              pick(after, primary.scope),
            ),
        )
          ? false
          : (before[primary.key] ?? false);
    }
    if (before === null || changedIdentity) {
      patches.push({ op: "add", key: identity(after), value: attrs });
    } else {
      const changed = Object.fromEntries(
        Object.entries(attrs).filter(
          ([key, value]) => !isEqual(value, before[key]),
        ),
      );
      // Promotion is an explicit action even if a local read role was missing.
      if (primary && row.primaryIntent) changed[primary.key] = true;
      if (Object.keys(changed).length)
        patches.push({
          op: "replace",
          key: identity(before),
          value: changed,
          expect,
        });
    }
  }
  return patches;
}

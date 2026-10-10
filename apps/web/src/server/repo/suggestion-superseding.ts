import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { and, eq, inArray } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { suggestion } from "~/server/db/schema";

/** Supersede pending rows only for fields actually declared suggestable. */
export async function supersedePendingSuggestionsForWrite(
  tx: DrizzleTransaction,
  entityName: string,
  recordIds: readonly string[],
  changedFields: readonly string[],
) {
  if (recordIds.length === 0 || changedFields.length === 0) return;
  const entity =
    entityName in entityFieldModels
      ? entityName
      : entityName[0]?.toLowerCase() + entityName.slice(1);
  if (!(entity in entityFieldModels)) return;
  // SAFETY: The preceding membership check proves `entity` is a declared field model.
  const model = entityFieldModels[entity as keyof typeof entityFieldModels];
  const suggestable = new Set<string>(
    model.fields
      .filter((field) => field.control?.suggest)
      .map((field) => field.key),
  );
  const fields = changedFields.filter((field) => suggestable.has(field));
  if (fields.length === 0) return;
  const conditions = [
    eq(suggestion.entity, entity),
    inArray(suggestion.recordId, [...recordIds]),
    inArray(suggestion.field, fields),
    eq(suggestion.status, "pending"),
  ];
  await tx
    .update(suggestion)
    .set({ status: "superseded" })
    .where(and(...conditions));
}

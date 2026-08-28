import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import { z } from "zod";

export const idParam = <TEntity extends ShortcodeEntity>(entity: TEntity) =>
  shortcodeSchema(entity);

export function strictFilterInput<TFields extends z.core.$ZodShape>(
  toolName: string,
  fields: TFields,
  filterFields: z.core.$ZodShape,
) {
  const valid = Object.keys(filterFields).sort().join(", ");
  return z.strictObject(fields, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `Unknown filter ${issue.keys.map((key) => `"${key}"`).join(", ")} for ${toolName}. Valid filters: ${valid}.`
        : undefined,
  });
}

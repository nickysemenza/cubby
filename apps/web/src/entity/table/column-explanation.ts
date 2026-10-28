import type { EntityRef } from "@cubby/schemas/entity";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { parseShortcode } from "@cubby/shared";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { entityMetadata } from "~/entity/metadata";
import type {
  ColumnExplanation,
  RowColumnExplanation,
} from "~/ui/data-table/table-meta";

/** Declare the same explanation before sizing that the row fallback renders. */
export function declaredColumnExplanation(
  queryClient: QueryClient,
  entity: EntityRef["entityKind"],
  columnId: string,
): ColumnExplanation | undefined {
  const field = entityMetadata(queryClient, entity).fields.fields.find(
    (candidate) =>
      candidate.key === columnId || candidate.key === `${columnId}Id`,
  );
  return field?.explanation
    ? { entity, field: field.key, label: field.label }
    : undefined;
}

const rowIdentitySchema = z.object({ id: z.string() });

export const resolveColumnExplanation = <TData>(
  queryClient: QueryClient,
  explanation: ColumnExplanation | RowColumnExplanation<TData> | undefined,
  row: TData,
  columnId?: string,
  surface: "list" | "summary" = "list",
): ColumnExplanation | undefined => {
  const identity = rowIdentitySchema.safeParse(row);
  const parsed = identity.success ? parseShortcode(identity.data.id) : null;
  const resolved = explanation
    ? "resolve" in explanation
      ? explanation.resolve(row)
      : explanation
    : parsed && columnId
      ? declaredColumnExplanation(queryClient, parsed.type, columnId)
      : undefined;
  if (!resolved) return undefined;
  const field: EntityFieldModel["fields"][number] | undefined = entityMetadata(
    queryClient,
    resolved.entity,
  ).fields.fields.find((candidate) => candidate.key === resolved.field);
  const path =
    field?.explanation?.projections?.[surface] ?? field?.explanation?.readPath;
  return path ? { ...resolved, path } : resolved;
};

import {
  ENTITY_LIST_READ_SCHEMAS,
  type ListEntity,
} from "./generated/entity-lists.gen";
import type { ListEnrichmentGroup, ListReadRow } from "./list-read-fields";

export const listReadFields = (entity: ListEntity) =>
  ENTITY_LIST_READ_SCHEMAS[entity].fields;

export function projectListRows(
  entity: ListEntity,
  rows: ListReadRow[],
  projection: {
    kind: "full" | "base" | "enrichment";
    groups?: readonly ListEnrichmentGroup[];
  },
) {
  const read = ENTITY_LIST_READ_SCHEMAS[entity];
  if (projection.kind === "full") return rows;
  return rows.map((row) =>
    projection.kind === "base"
      ? read.project(row, "core")
      : Object.assign(
          { id: row.id },
          ...(projection.groups ?? []).map((group) => read.project(row, group)),
        ),
  );
}

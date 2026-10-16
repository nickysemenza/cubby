import {
  ENTITY_LIST_READ_SCHEMAS,
  type ListEntity,
} from "../generated/entity-lists.gen";
import {
  listEnrichmentGroups,
  type ListEnrichmentGroup,
  type ListReadRow,
} from "./list-read-fields";

export const listReadFields = (entity: ListEntity) =>
  ENTITY_LIST_READ_SCHEMAS[entity].fields;

export const listGroupsForFields = (
  entity: ListEntity,
  fields: readonly string[],
) =>
  listEnrichmentGroups.filter((group) =>
    listReadFields(entity)[group].some((field) => fields.includes(field)),
  );

/** Pick actual loaded fields; a missing dependency must fail instead of producing partial success. */
export function selectListReadFields(
  row: ListReadRow,
  fields: readonly string[],
): ListReadRow {
  const output: ListReadRow = { id: row.id };
  for (const field of fields) {
    if (!Object.hasOwn(row, field))
      throw new Error(`Requested record field was not loaded: ${field}`);
    output[field] = row[field];
  }
  return output;
}

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

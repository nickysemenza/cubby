import {
  ENTITY_LIST_READ_SCHEMAS,
  type ListEntity,
} from "../generated/entity-lists.gen";
import {
  listEnrichmentGroups,
  type ListProjection,
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

/** Finalize after repository and transport-owned loaders have supplied their fields. */
export function selectListReadRows(
  entity: ListEntity,
  rows: ListReadRow[],
  fields: readonly string[],
): ListReadRow[] {
  const read = ENTITY_LIST_READ_SCHEMAS[entity];
  const groups = listGroupsForFields(entity, fields);
  return rows.map((row) => {
    // An optional field the complete list also omits stays absent; every
    // other field must be loaded. Check raw mapped values before a group's
    // schema can insert defaults.
    const loaded = fields.filter(
      (field) => !read.omittable.has(field) || Object.hasOwn(row, field),
    );
    selectListReadFields(row, loaded);
    const validated = Object.assign(
      read.project(row, "core"),
      ...groups.map((group) => read.project(row, group)),
    );
    return selectListReadFields(validated, loaded);
  });
}

export function projectListRows(
  entity: ListEntity,
  rows: ListReadRow[],
  projection: ListProjection,
) {
  const read = ENTITY_LIST_READ_SCHEMAS[entity];
  switch (projection.kind) {
    case "full":
    case "selected":
      // Complete and selected consumers validate after all their loaders run.
      return rows;
    case "base":
      return rows.map((row) => read.project(row, "core"));
    case "enrichment":
      return rows.map((row) =>
        Object.assign(
          { id: row.id },
          ...(projection.groups ?? []).map((group) => read.project(row, group)),
        ),
      );
    default: {
      const unhandled: never = projection;
      throw new Error(`Unsupported list projection: ${unhandled}`);
    }
  }
}

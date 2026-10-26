import {
  ENTITY_LIST_READ_SCHEMAS,
  type ListEntity,
} from "../generated/entity-lists.gen";
import { type ListProjection, type ListReadRow } from "./list-read-fields";

export const listReadSchema = (entity: ListEntity) =>
  ENTITY_LIST_READ_SCHEMAS[entity].schema;

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
  return rows.map((row) => {
    // An optional field the complete list also omits stays absent; every
    // other field must be loaded. Check raw mapped values before a group's
    // schema can insert defaults.
    const loaded = fields.filter(
      (field) => !read.omittable.has(field) || Object.hasOwn(row, field),
    );
    selectListReadFields(row, loaded);
    const validated: ListReadRow = { id: row.id };
    for (const field of loaded)
      validated[field] = read.schema.shape[field].parse(row[field]);
    return validated;
  });
}

export function projectListRows(
  entity: ListEntity,
  rows: ListReadRow[],
  projection: ListProjection,
) {
  return projection.kind === "selected"
    ? selectListReadRows(entity, rows, projection.fields)
    : rows;
}

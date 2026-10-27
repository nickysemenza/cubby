import { type ListEntity } from "~/entity/generated/entity-lists.gen";
import {
  type ListProjection,
  type ListReadRow,
} from "~/entity/model/list-read-fields";
import { ENTITY_REPOSITORY_READ_SCHEMAS } from "~/server/generated/entity-bindings.gen";

export const listReadSchema = (entity: ListEntity) =>
  ENTITY_REPOSITORY_READ_SCHEMAS[entity].schema;

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

/** Validate requested fields while retaining loaded dependencies for envelope construction. */
export function validateListReadRows(
  entity: ListEntity,
  rows: ListReadRow[],
  fields: readonly string[],
): ListReadRow[] {
  const read = ENTITY_REPOSITORY_READ_SCHEMAS[entity];
  return rows.map((row) => {
    // An optional field the complete list also omits stays absent; every
    // other field must be loaded. Check raw mapped values before a group's
    // schema can insert defaults.
    const loaded = fields.filter(
      (field) => !read.omittable.has(field) || Object.hasOwn(row, field),
    );
    selectListReadFields(row, loaded);
    const validated: ListReadRow = { ...row };
    for (const field of loaded)
      validated[field] = read.schema.shape[field].parse(row[field]);
    return validated;
  });
}

/** Select only requested fields for internal consumers that do not construct envelopes. */
export function selectListReadRows(
  entity: ListEntity,
  rows: ListReadRow[],
  fields: readonly string[],
): ListReadRow[] {
  return validateListReadRows(entity, rows, fields).map((row) =>
    selectListReadFields(
      row,
      fields.filter((field) => Object.hasOwn(row, field)),
    ),
  );
}

export function projectListRows(
  entity: ListEntity,
  rows: ListReadRow[],
  projection: ListProjection,
) {
  return validateListReadRows(entity, rows, projection);
}

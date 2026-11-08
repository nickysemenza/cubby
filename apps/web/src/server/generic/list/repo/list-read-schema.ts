import { type ListEntity } from "~/entity/model/list-contracts";
import {
  type ListProjection,
  type ListReadRow,
} from "~/entity/model/list-read-fields";
import type { compileListReadSchema } from "~/entity/model/list-read-fields";

export type RepositoryReadSchema = ReturnType<typeof compileListReadSchema> & {
  readonly entity: ListEntity;
  readonly listKeys: ReadonlySet<string>;
};

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
  read: RepositoryReadSchema,
  rows: ListReadRow[],
  fields: readonly string[],
): ListReadRow[] {
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
  read: RepositoryReadSchema,
  rows: ListReadRow[],
  fields: readonly string[],
): ListReadRow[] {
  return validateListReadRows(read, rows, fields).map((row) =>
    selectListReadFields(
      row,
      fields.filter((field) => Object.hasOwn(row, field)),
    ),
  );
}

export function projectListRows(
  read: RepositoryReadSchema,
  rows: ListReadRow[],
  projection: ListProjection,
) {
  return validateListReadRows(read, rows, projection);
}

import { z } from "zod";

export const listReadRowSchema = z
  .object({ id: z.string() })
  .catchall(z.unknown());
export type ListReadRow = z.output<typeof listReadRowSchema>;

/**
 * The read keys a list or detail read loads. A count reads none; a full page
 * reads its scaffold's list fields, a detail read its detail fields.
 */
export type ListProjection = readonly string[];

/**
 * An entity's one repository read schema: every list and detail key. A key
 * whose list and detail shapes differ accepts either, the richer detail shape
 * first (a page loads the narrow value, a record read the detail override).
 */
export function mergeReadSchemas(list: z.ZodObject, detail: z.ZodObject) {
  if (list === detail) return list;
  const fields = { ...list.shape };
  const required = (schema: z.ZodType) =>
    schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  for (const [key, value] of Object.entries(detail.shape)) {
    const page = fields[key];
    if (page === undefined || page === value) {
      fields[key] = value;
      continue;
    }
    // Either side omitting the key keeps it omittable.
    const either = z.union([required(value), required(page)]);
    fields[key] =
      value instanceof z.ZodOptional || page instanceof z.ZodOptional
        ? either.optional()
        : either;
  }
  return z.object(fields);
}

export function compileListReadSchema(schema: z.ZodObject) {
  return {
    schema,
    omittable: new Set(
      Object.keys(schema.shape).filter(
        (key) => schema.shape[key] instanceof z.ZodOptional,
      ),
    ),
  };
}

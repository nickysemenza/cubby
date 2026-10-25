import { z } from "zod";

export const listReadRowSchema = z
  .object({ id: z.string() })
  .catchall(z.unknown());
export type ListReadRow = z.output<typeof listReadRowSchema>;

/** Full pages, explicit projections, and count-only repository reads. */
export type ListProjection =
  | { kind: "full" }
  | { kind: "base" }
  | { kind: "selected"; fields: readonly string[] };

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

/** Canonical media payloads and counters, independent of the page loading strategy. */
const mediaReadFields = new Set([
  "displayImages",
  "images",
  "labelImages",
  "itemImageCount",
  "labelImageCount",
  "logo",
  "vendorLogo",
]);
export const isListMediaField = (key: string): boolean =>
  mediaReadFields.has(key);

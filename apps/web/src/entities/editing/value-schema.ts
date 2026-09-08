import { z } from "zod";

/** Browser-local draft values may retain Dates until their intent serializes them. */
export const entityEditValueSchema = z.union([
  z.json(),
  z.date(),
  z.undefined(),
]);
export const entityEditValueBagSchema = z.record(
  z.string(),
  entityEditValueSchema,
);

export type EntityEditValue = z.infer<typeof entityEditValueSchema>;
export type EntityEditValueBag = z.infer<typeof entityEditValueBagSchema>;

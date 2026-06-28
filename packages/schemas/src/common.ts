import { z } from "zod";
import { id } from "./identifiers";

export const dbTimestampsOut = z
  .object({
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .describe("db timestamps for an API response");

export function extractDbTimestampsFromDBRec<
  T extends { createdAt: Date; updatedAt: Date },
>(dbRec: T): z.infer<typeof dbTimestampsOut> {
  return {
    createdAt: dbRec.createdAt,
    updatedAt: dbRec.updatedAt,
  };
}

/**
 * A non-empty entity name for CREATE/UPDATE *input* schemas. Trims surrounding
 * whitespace and rejects empty / whitespace-only values.
 *
 * Apply this on input schemas only — never on the `*Base` / `*Out` schemas that
 * are reused for reads, so any pre-existing rows with empty names still parse on
 * read (the gap this guards against is *new* blank names, not historical ones).
 */
export const requiredName = (label = "Name") =>
  z.string().trim().min(1, `${label} is required`);

export const IDInput = z
  .object({
    id: id,
  })
  .describe("input for retrieving by ID");

/** Delete-tool output: count of rows soft-deleted. */
export const deletedCountOut = z.object({
  deleted: z.number().int().nonnegative(),
});
export type DeletedCountOut = z.infer<typeof deletedCountOut>;

// Base entity schema with common fields
export const baseEntitySchema = z.object({
  id: id,
  name: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

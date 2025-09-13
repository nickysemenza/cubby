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

export const IDInput = z
  .object({
    id: id,
  })
  .describe("input for retrieving by ID");

// Base entity schema with common fields
export const baseEntitySchema = z
  .object({
    id: id,
    name: z.string(),
  })
  .extend(dbTimestampsOut.shape);

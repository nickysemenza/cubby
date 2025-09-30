import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { findAllProblems } from "~/server/repo/problems";

// Output schemas for each problem type
const duplicateUniqueProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  expectedQuantity: z.number().nullable(),
  locations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});

const orphanedProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  createdAt: z.date(),
});

const invalidUPCSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  upc: z.string(),
  issue: z.enum(["invalid_format", "duplicate"]),
});

const productWithoutMappingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  createdAt: z.date(),
});

const invalidInventoryAmountSchema = z.object({
  id: z.string(),
  productName: z.string(),
  locationName: z.string(),
  amount: z.object({
    value: z.number(),
    unit: z.string(),
  }),
  issue: z.enum(["zero", "negative"]),
});

const emptyLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  createdAt: z.date(),
  lastBulkInventory: z.date().nullable(),
});

// Combined output schema for all problems
const allProblemsSchema = z.object({
  duplicateUniqueProducts: z.array(duplicateUniqueProductSchema),
  orphanedProducts: z.array(orphanedProductSchema),
  invalidUPCs: z.array(invalidUPCSchema),
  productsWithoutMappings: z.array(productWithoutMappingsSchema),
  invalidInventoryAmounts: z.array(invalidInventoryAmountSchema),
  emptyLocations: z.array(emptyLocationSchema),
  totalProblems: z.number(),
});

// Main procedure to get all problems
const getAllProblems = protectedProcedure
  .output(allProblemsSchema)
  .query(async ({ ctx }) => {
    return await findAllProblems(ctx.db, ctx.projectId);
  });

export const problemsRouter = createTRPCRouter({
  getAllProblems,
});

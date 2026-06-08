import { amount } from "@cubby/schemas/codec";
import { z } from "zod";
import { findAllProblems, findAllProblemsCount } from "~/server/repo/problems";
import { createTRPCRouter, protectedProcedure } from "../trpc";

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
  amount,
  issue: z.enum(["zero", "negative"]),
});

const emptyLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  createdAt: z.date(),
  lastBulkInventory: z.date().nullable(),
  aiDescription: z.string().nullable(),
  firstImageUrl: z.string().nullable(),
  firstImageId: z.string().nullable(),
});

const productWithNoImagesSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  upc: z.string().nullable(),
});

const productWithWrongCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  category: z.string().nullable(),
  indicator: z.enum(["ndb", "ingredient"]),
});

const inventoryWithStaleValuationSchema = z.object({
  id: z.string(),
  productName: z.string(),
  locationName: z.string(),
  storedValuation: z.number().nullable(),
  expectedValuation: z.number().nullable(),
});

const productWithIslandedMappingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  islandCount: z.number(),
  islands: z.array(
    z.object({
      units: z.array(z.string()),
      exampleUnit: z.string(),
    }),
  ),
});

const locationWithoutAiDescriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  imageCount: z.number(),
});

const staleIngredientParseSchema = z.object({
  recipeSectionIngredientId: z.string(),
  recipeId: z.string(),
  recipeName: z.string(),
  ingredientId: z.string(),
  storedName: z.string(),
  rawLine: z.string(),
  parsedName: z.string(),
});

// Combined output schema for all problems
const allProblemsSchema = z.object({
  duplicateUniqueProducts: z.array(duplicateUniqueProductSchema),
  orphanedProducts: z.array(orphanedProductSchema),
  invalidUPCs: z.array(invalidUPCSchema),
  productsWithoutMappings: z.array(productWithoutMappingsSchema),
  inventoryWithStaleValuations: z.array(inventoryWithStaleValuationSchema),
  invalidInventoryAmounts: z.array(invalidInventoryAmountSchema),
  emptyLocations: z.array(emptyLocationSchema),
  productsWithNoImages: z.array(productWithNoImagesSchema),
  productsWithWrongCategory: z.array(productWithWrongCategorySchema),
  productsWithIslandedMappings: z.array(productWithIslandedMappingsSchema),
  locationsWithoutAiDescription: z.array(locationWithoutAiDescriptionSchema),
  staleIngredientParses: z.array(staleIngredientParseSchema),
  totalProblems: z.number(),
});

// Main procedure to get all problems
const getAllProblems = protectedProcedure
  .output(allProblemsSchema)
  .query(async ({ ctx }) => {
    return await findAllProblems(ctx.db);
  });

// Count-only procedure for badge display (optimized)
const getProblemsCount = protectedProcedure
  .output(
    z.object({
      total: z.number(),
      byType: z.object({
        duplicateUniqueProducts: z.number(),
        orphanedProducts: z.number(),
        invalidUPCs: z.number(),
        productsWithoutMappings: z.number(),
        invalidInventoryAmounts: z.number(),
        emptyLocations: z.number(),
        productsWithNoImages: z.number(),
        productsWithWrongCategory: z.number(),
        inventoryWithStaleValuations: z.number(),
        productsWithIslandedMappings: z.number(),
        locationsWithoutAiDescription: z.number(),
        staleIngredientParses: z.number(),
      }),
    }),
  )
  .query(async ({ ctx }) => {
    return await findAllProblemsCount(ctx.db);
  });

export const problemsRouter = createTRPCRouter({
  getAllProblems,
  getProblemsCount,
});

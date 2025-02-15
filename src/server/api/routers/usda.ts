import { createTRPCRouter, publicProcedure } from "../trpc";
import { brandedFoodSummary } from "~/schemas/usda";
import { z } from "zod";
import { upc } from "~/schemas/util";
import { getBrandedFoodSummary, getFoodSummaryByID } from "~/server/repo/usda";

const getByUPC = publicProcedure
  .input(
    z.object({
      upc: upc,
    }),
  )
  .output(brandedFoodSummary.nullable())
  .query(
    async ({ ctx, input }) => await getBrandedFoodSummary(ctx.db, input.upc),
  );

const getByID = publicProcedure
  .input(
    z.object({
      id: z.number(),
    }),
  )
  .output(brandedFoodSummary.nullable())
  .query(async ({ ctx, input }) => await getFoodSummaryByID(ctx.db, input.id));

export const usdaRouter = createTRPCRouter({
  getByUPC,
  getByID,
});

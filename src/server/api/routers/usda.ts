import { createTRPCRouter, publicProcedure } from "../trpc";
import { foodLookupParam, foodSummary } from "~/schemas/usda";
import { z } from "zod";
import { findFood, getFoodSummaryByID } from "~/server/repo/usda";

const getByUPC = publicProcedure
  .input(foodLookupParam)
  .output(foodSummary.nullable())
  .query(async ({ ctx, input }) => await findFood(ctx.db, input));

const getByID = publicProcedure
  .input(
    z.object({
      id: z.number(),
    }),
  )
  .output(foodSummary.nullable())
  .query(async ({ ctx, input }) => await getFoodSummaryByID(ctx.db, input.id));

export const usdaRouter = createTRPCRouter({
  getByUPC,
  getByID,
});

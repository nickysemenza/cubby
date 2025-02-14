import { createTRPCRouter, publicProcedure } from "../trpc";
import { brandedFoodSummary } from "~/schemas/usda";
import { z } from "zod";
import { upc } from "~/schemas/util";
import { getBrandedFoodSummary, getFoodByIDDeep } from "~/server/repo/usda";

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
  .output(z.any().nullable())
  .query(async ({ ctx, input }) => await getFoodByIDDeep(ctx.db, input.id));

export const usdaRouter = createTRPCRouter({
  getByUPC,
  getByID,
});

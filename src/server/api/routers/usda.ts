import { createTRPCRouter, publicProcedure } from "../trpc";
import { brandedFoodSummary } from "~/schemas/usda";
import { z } from "zod";
import { upc } from "~/schemas/util";
import { getBrandedFoodSummary } from "~/server/repo/usda";

const getByID = publicProcedure
  .input(
    z.object({
      upc: upc,
    }),
  )
  .output(brandedFoodSummary.nullable())
  .query(
    async ({ ctx, input }) => await getBrandedFoodSummary(ctx.db, input.upc),
  );

export const usdaRouter = createTRPCRouter({
  getByID,
});

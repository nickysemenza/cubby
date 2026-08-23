import { productShortcode } from "@cubby/schemas/identifiers";
import { relatednessOutSchema } from "@cubby/schemas/relatedness";
import { getProductRelatedness } from "~/server/services/relatedness.service";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const relatednessRouter = createTRPCRouter({
  product: protectedProcedure
    .input(productShortcode)
    .output(strictOutput(relatednessOutSchema))
    .query(
      async ({ ctx, input }) => await getProductRelatedness(ctx.db, input),
    ),
});

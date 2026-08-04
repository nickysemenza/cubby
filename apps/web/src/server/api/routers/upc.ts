import {
  productLookupResponseSchema,
  upcLookupInput,
} from "@cubby/upc-contract";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const lookup = protectedProcedure
  .input(upcLookupInput)
  .output(strictOutput(productLookupResponseSchema.nullable()))
  .query(async ({ ctx, input }) => {
    return await ctx.upcLookupClient.lookup(input.upc);
  });

export const upcRouter = createTRPCRouter({
  lookup,
});

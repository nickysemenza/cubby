import {
  searchResponseSchema,
  upcLookupInput,
  upcLookupResponseSchema,
  upcSearchInput,
} from "@cubby/upc-contract";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const lookup = protectedProcedure
  .input(upcLookupInput)
  .output(upcLookupResponseSchema.nullable())
  .query(async ({ ctx, input }) => {
    return await ctx.upcLookupClient.lookup(input.upc);
  });

const search = protectedProcedure
  .input(upcSearchInput)
  // Search results omit `cached` (not a cache read) — see searchResponseSchema.
  .output(searchResponseSchema)
  .query(async ({ ctx, input }) => {
    return await ctx.upcLookupClient.search(input.query, input.limit);
  });

export const upcRouter = createTRPCRouter({
  lookup,
  search,
});

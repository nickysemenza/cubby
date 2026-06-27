import { upcLookupInput, upcSearchInput } from "@cubby/schemas/upc";
import {
  searchResponseSchema,
  upcLookupResponseSchema,
} from "@cubby/upc-lookup/schemas";
import { createTRPCRouter, publicProcedure } from "../trpc";

const lookup = publicProcedure
  .input(upcLookupInput)
  .output(upcLookupResponseSchema.nullable())
  .query(async ({ ctx, input }) => {
    return await ctx.upcLookupClient.lookup(input.upc);
  });

const search = publicProcedure
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

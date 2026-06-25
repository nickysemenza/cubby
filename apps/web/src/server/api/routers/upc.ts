import {
  searchResponseSchema,
  upcLookupResponseSchema,
} from "@cubby/upc-lookup/schemas";
import { upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";

const lookup = publicProcedure
  .input(z.object({ upc: upc }))
  .output(upcLookupResponseSchema.nullable())
  .query(async ({ ctx, input }) => {
    return await ctx.upcLookupClient.lookup(input.upc);
  });

const search = publicProcedure
  .input(
    z.object({
      query: z.string().min(1),
      limit: z.number().min(1).max(100).default(20),
    }),
  )
  // Search results omit `cached` (not a cache read) — see searchResponseSchema.
  .output(searchResponseSchema)
  .query(async ({ ctx, input }) => {
    return await ctx.upcLookupClient.search(input.query, input.limit);
  });

export const upcRouter = createTRPCRouter({
  lookup,
  search,
});

import {
  globalSearchInputSchema,
  globalSearchOut,
  type SearchResultItem,
} from "@cubby/schemas/search";
import { globalSearch } from "~/server/repo/search";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Main search procedure
const global = protectedProcedure
  .input(globalSearchInputSchema)
  .output(globalSearchOut)
  .query(async ({ ctx, input }): Promise<SearchResultItem[]> => {
    return await globalSearch(ctx.db, input.query, input.limit);
  });

export const searchRouter = createTRPCRouter({
  global,
});

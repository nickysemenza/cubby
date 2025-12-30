import { z } from "zod";
import {
  type SearchResultItem,
  searchResultItemSchema,
} from "~/schemas/search";
import { globalSearch } from "~/server/repo/search";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Input schema
const globalSearchInputSchema = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().min(1).max(10).default(5),
});

// Main search procedure
const global = protectedProcedure
  .input(globalSearchInputSchema)
  .output(z.array(searchResultItemSchema))
  .query(async ({ ctx, input }): Promise<SearchResultItem[]> => {
    return await globalSearch(
      ctx.db,
      ctx.organizationId,
      input.query,
      input.limit,
    );
  });

export const searchRouter = createTRPCRouter({
  global,
});

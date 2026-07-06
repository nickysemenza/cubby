import {
  enqueueEmbeddingBackfillInputSchema,
  enqueueEmbeddingBackfillOutSchema,
} from "@cubby/schemas/background-jobs";
import {
  globalSearchInputSchema,
  globalSearchOut,
  type SearchResultItem,
  searchDebugInputSchema,
  searchDebugOutSchema,
  semanticBackfillInputSchema,
  semanticBackfillOutSchema,
} from "@cubby/schemas/search";
import {
  backfillEntityEmbeddings,
  debugHybridSearch,
  enqueueEntityEmbeddingBackfill,
  hybridGlobalSearch,
  lexicalGlobalSearch,
} from "~/server/services/semantic-search.service";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Main search procedure
const global = protectedProcedure
  .input(globalSearchInputSchema)
  .output(globalSearchOut)
  .query(async ({ ctx, input }): Promise<SearchResultItem[]> => {
    return input.mode === "lexical"
      ? await lexicalGlobalSearch(ctx.db, input.query, input.limit)
      : await hybridGlobalSearch(ctx.db, input.query, input.limit);
  });

export const searchRouter = createTRPCRouter({
  global,
  debug: protectedProcedure
    .input(searchDebugInputSchema)
    .output(searchDebugOutSchema)
    .query(async ({ ctx, input }) => {
      return await debugHybridSearch(ctx.db, input.query, input.limit);
    }),
  backfillEmbeddings: protectedProcedure
    .input(semanticBackfillInputSchema)
    .output(semanticBackfillOutSchema)
    .mutation(async ({ ctx, input }) => {
      return await backfillEntityEmbeddings(ctx.db, input);
    }),
  enqueueEmbeddingBackfill: protectedProcedure
    .input(enqueueEmbeddingBackfillInputSchema)
    .output(enqueueEmbeddingBackfillOutSchema)
    .mutation(async ({ ctx, input }) => {
      return await enqueueEntityEmbeddingBackfill(ctx.db, input);
    }),
});

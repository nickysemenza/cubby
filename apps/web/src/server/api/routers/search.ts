import {
  enqueueEmbeddingBackfillInputSchema,
  enqueueEmbeddingBackfillOutSchema,
} from "@cubby/schemas/background-jobs";
import {
  globalSearchInputSchema,
  globalSearchOut,
  type SearchResultItem,
  searchDebugOutSchema,
  semanticBackfillInputSchema,
  semanticBackfillOutSchema,
  similarEntitiesInputSchema,
  similarEntitiesOut,
} from "@cubby/schemas/search";
import {
  backfillEntityEmbeddings,
  debugHybridSearch,
  enqueueEntityEmbeddingBackfill,
  findSimilarEntitiesForPair,
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
  /** Entity-to-entity similarity over the stored embeddings (allowlisted pairs). */
  similar: protectedProcedure
    .input(similarEntitiesInputSchema)
    .output(similarEntitiesOut)
    .query(async ({ ctx, input }) => {
      return await findSimilarEntitiesForPair(ctx.db, input);
    }),
  debug: protectedProcedure
    .input(globalSearchInputSchema)
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

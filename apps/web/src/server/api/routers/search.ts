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
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

// Main search procedure
const global = protectedProcedure
  .input(globalSearchInputSchema)
  .output(strictOutput(globalSearchOut))
  .query(async ({ ctx, input }): Promise<SearchResultItem[]> => {
    return input.mode === "lexical"
      ? await lexicalGlobalSearch(
          ctx.db,
          input.query,
          input.limit,
          input.entityType,
        )
      : await hybridGlobalSearch(
          ctx.db,
          input.query,
          input.limit,
          input.entityType,
        );
  });

export const searchRouter = createTRPCRouter({
  global,
  /** Entity-to-entity similarity over the stored embeddings (allowlisted pairs). */
  similar: protectedProcedure
    .input(similarEntitiesInputSchema)
    .output(strictOutput(similarEntitiesOut))
    .query(async ({ ctx, input }) => {
      return await findSimilarEntitiesForPair(ctx.db, input);
    }),
  debug: protectedProcedure
    .input(globalSearchInputSchema)
    .output(strictOutput(searchDebugOutSchema))
    .query(async ({ ctx, input }) => {
      return await debugHybridSearch(
        ctx.db,
        input.query,
        input.limit,
        input.entityType,
      );
    }),
  backfillEmbeddings: protectedProcedure
    .input(semanticBackfillInputSchema)
    .output(strictOutput(semanticBackfillOutSchema))
    .mutation(async ({ ctx, input }) => {
      return await backfillEntityEmbeddings(ctx.db, input);
    }),
  enqueueEmbeddingBackfill: protectedProcedure
    .input(enqueueEmbeddingBackfillInputSchema)
    .output(strictOutput(enqueueEmbeddingBackfillOutSchema))
    .mutation(async ({ ctx, input }) => {
      return await enqueueEntityEmbeddingBackfill(ctx.db, input);
    }),
});

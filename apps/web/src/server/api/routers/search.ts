import {
  enqueueEmbeddingBackfillInputSchema,
  enqueueEmbeddingBackfillOutSchema,
} from "@cubby/schemas/background-jobs";
import {
  relatedSearchOutSchema,
  repairSearchDocumentsOutSchema,
  requestEmbeddingRefreshInputSchema,
  requestEmbeddingRefreshOutSchema,
  searchDebugOutSchema,
  searchDocumentMaintenanceSchema,
  searchHitsOut,
  searchQueryInputSchema,
  similarEntitiesInputSchema,
  similarEntitiesOut,
} from "@cubby/schemas/search";
import {
  findRelatedSearchHits,
  findSearchHits,
  inspectSearchDocumentHealth,
  repairSearchDocuments,
} from "~/server/services/search.service";
import {
  enqueueEntityEmbeddingBackfill,
  findSimilarEntitiesForPair,
  requestEmbeddingRefresh,
} from "~/server/services/semantic-search.service";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const searchRouter = createTRPCRouter({
  /** Fast, deterministic lexical search. No embedding request is made here. */
  find: protectedProcedure
    .input(searchQueryInputSchema)
    .output(strictOutput(searchHitsOut))
    .query(async ({ ctx, input }) => await findSearchHits(ctx.db, input)),

  /** On-demand catalog integrity check; intentionally absent from hot paths. */
  documentHealth: protectedProcedure
    .output(strictOutput(searchDocumentMaintenanceSchema))
    .query(async ({ ctx }) => await inspectSearchDocumentHealth(ctx.db)),

  /** Queue missing/stale repairs and retire orphaned documents immediately. */
  repairDocuments: protectedProcedure
    .output(strictOutput(repairSearchDocumentsOutSchema))
    .mutation(async ({ ctx }) => await repairSearchDocuments(ctx.db)),

  /** Opt-in semantic matches, returned separately so they never reorder lexical hits. */
  related: protectedProcedure
    .input(searchQueryInputSchema)
    .output(strictOutput(relatedSearchOutSchema))
    .query(
      async ({ ctx, input }) => await findRelatedSearchHits(ctx.db, input),
    ),

  /** Entity-to-entity similarity over the stored embeddings (allowlisted pairs). */
  similar: protectedProcedure
    .input(similarEntitiesInputSchema)
    .output(strictOutput(similarEntitiesOut))
    .query(async ({ ctx, input }) => {
      return await findSimilarEntitiesForPair(ctx.db, input);
    }),

  /**
   * Debug remains a compact, public-only view while the diagnostics UI moves to
   * the indexed retrieval pipeline.
   */
  debug: protectedProcedure
    .input(searchQueryInputSchema)
    .output(strictOutput(searchDebugOutSchema))
    .query(async ({ ctx, input }) => {
      const [lexical, related] = await Promise.all([
        findSearchHits(ctx.db, input),
        findRelatedSearchHits(ctx.db, input),
      ]);
      return {
        query: input.query,
        lexical,
        semantic: related.results,
        results: lexical,
      };
    }),

  enqueueEmbeddingBackfill: protectedProcedure
    .input(enqueueEmbeddingBackfillInputSchema)
    .output(strictOutput(enqueueEmbeddingBackfillOutSchema))
    .mutation(async ({ ctx, input }) => {
      return await enqueueEntityEmbeddingBackfill(ctx.db, input);
    }),

  requestEmbeddingRefresh: protectedProcedure
    .input(requestEmbeddingRefreshInputSchema)
    .output(strictOutput(requestEmbeddingRefreshOutSchema))
    .mutation(
      async ({ ctx, input }) => await requestEmbeddingRefresh(ctx.db, input),
    ),
});

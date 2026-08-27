import type { enqueueEmbeddingBackfillInputSchema } from "@cubby/schemas/background-jobs";
import type {
  requestEmbeddingRefreshInputSchema,
  searchQueryInputSchema,
  similarEntitiesInputSchema,
} from "@cubby/schemas/search";
import type { z } from "zod";
import type { Database } from "~/server/db";
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
export const findSearchHitsWorkflow = (
  db: Database,
  input: z.output<typeof searchQueryInputSchema>,
) => findSearchHits(db, input);

export const inspectSearchDocumentHealthWorkflow = (db: Database) =>
  inspectSearchDocumentHealth(db);

export const repairSearchDocumentsWorkflow = (db: Database) =>
  repairSearchDocuments(db);

export const findRelatedSearchHitsWorkflow = (
  db: Database,
  input: z.output<typeof searchQueryInputSchema>,
) => findRelatedSearchHits(db, input);

export const findSimilarEntitiesWorkflow = (
  db: Database,
  input: z.output<typeof similarEntitiesInputSchema>,
) => findSimilarEntitiesForPair(db, input);

export const inspectSearchDebugWorkflow = async (
  db: Database,
  input: z.output<typeof searchQueryInputSchema>,
) => {
  const [lexical, related] = await Promise.all([
    findSearchHits(db, input),
    findRelatedSearchHits(db, input),
  ]);
  return {
    query: input.query,
    lexical,
    semantic: related.results,
    results: lexical,
  };
};

export const enqueueEmbeddingBackfillWorkflow = (
  db: Database,
  input: z.output<typeof enqueueEmbeddingBackfillInputSchema>,
) => enqueueEntityEmbeddingBackfill(db, input);

export const requestEmbeddingRefreshWorkflow = (
  db: Database,
  input: z.output<typeof requestEmbeddingRefreshInputSchema>,
) => requestEmbeddingRefresh(db, input);

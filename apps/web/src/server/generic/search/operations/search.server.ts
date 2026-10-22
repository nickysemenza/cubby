import type { requestEmbeddingRefreshInputSchema } from "@cubby/schemas/search";
import type { z } from "zod";

import {
  searchContract,
  searchStreamsContract,
} from "~/contracts/search.contract";
import type { Database } from "~/server/db";
import { findSimilarEntitiesWorkflow } from "~/server/generic/embedding/service/semantic-similarity";
import {
  findGroupedSearchHits,
  findRelatedSearchGroups,
} from "~/server/generic/search/service/search-grouping.service";
import { repairSearchIndex } from "~/server/generic/search/service/search-index-repair.service";
import {
  findRelatedSearchHits,
  findSearchHits,
} from "~/server/generic/search/service/search.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { implementSubscriptionDomain } from "~/server/operation-runtime/subscription-domain.server";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

type RefreshInput = z.output<typeof requestEmbeddingRefreshInputSchema>;
export async function requestEmbeddingRefreshWorkflow(
  db: Database,
  input: RefreshInput,
) {
  const entityId = await resolveOrThrow(db, input.entityKind, input.entityId);
  // Acknowledgment means the durable intent committed, even if the queue wake is lost.
  await publishBackgroundTasks(
    db,
    [
      {
        kind: "entity-embedding.refresh",
        requestedAt: new Date().toISOString(),
        entityKind: input.entityKind,
        entityId,
      },
    ],
    { source: "relatedness.indexNow" },
  );
  return { accepted: true as const };
}

/**
 * User-facing search reads ride the cached read handle; debug and the
 * embedding refresh stay authoritative through the central browser read policy.
 */
export const searchHandlers = implementOperationDomain(searchContract, {
  find: (context, input) => findSearchHits(context.db, input),
  grouped: (context, input) => findGroupedSearchHits(context.db, input),
  related: (context, input) => findRelatedSearchHits(context.db, input),
  relatedGrouped: (context, input) =>
    findRelatedSearchGroups(context.db, input),
  debug: async (context, input) => {
    const [lexical, related] = await Promise.all([
      findSearchHits(context.db, input),
      findRelatedSearchHits(context.db, input),
    ]);
    return {
      query: input.query,
      lexical,
      semantic: related.results,
      results: lexical,
    };
  },
  requestEmbeddingRefresh: (context, input) =>
    requestEmbeddingRefreshWorkflow(context.db, input),
  global: async (context, input) => {
    const { includeRelated, ...query } = input;
    if (!includeRelated)
      return {
        results: await findSearchHits(context.db, query),
        related: [],
        relatedStatus: "not_requested" as const,
      };
    const [results, related] = await Promise.all([
      findSearchHits(context.db, query),
      findRelatedSearchHits(context.db, query),
    ]);
    const primaryKeys = new Set(
      results.map((result) => `${result.entityKind}:${result.id}`),
    );
    return {
      results,
      related: related.results.filter(
        (result) => !primaryKeys.has(`${result.entityKind}:${result.id}`),
      ),
      relatedStatus: related.status,
    };
  },
  similar: (context, input) => findSimilarEntitiesWorkflow(context.db, input),
});

export const searchStreamHandlers = implementSubscriptionDomain(
  searchStreamsContract,
  {
    repairIndex: async function* (context, _input, signal) {
      yield* repairSearchIndex(context.db, signal);
    },
  },
);

import { createLogger } from "@cubby/worker-tracing";
import type { requestEmbeddingRefreshInputSchema } from "@cubby/schemas/search";
import type { z } from "zod";

import {
  searchContract,
  searchStreamsContract,
} from "~/contracts/search.contract";
import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import {
  getSearchIndexRepairWorkflow,
  isCloudflareRuntime,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { streamSearchIndexRepairWorkflow } from "~/server/search-index-repair-workflow-adapter";
import {
  findGroupedSearchHits,
  findRelatedSearchGroups,
} from "~/server/services/search-grouping.service";
import { repairSearchIndex } from "~/server/services/search-index-repair.service";
import {
  findRelatedSearchHits,
  findSearchHits,
} from "~/server/services/search.service";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import { getRequestId } from "~/server/tracing";

import { findSimilarEntitiesWorkflow } from "./semantic-similarity.server";

const log = createLogger("search-index-repair");

type RefreshInput = z.output<typeof requestEmbeddingRefreshInputSchema>;
export async function requestEmbeddingRefreshWorkflow(
  db: Database,
  input: RefreshInput,
) {
  const entityId = await resolveOrThrow(db, input.entityKind, input.entityId);
  // Awaited, unlike a mutation's after-commit publication: this IS the
  // user's action, so its acknowledgment must mean the queue accepted it.
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
      const workflow = getSearchIndexRepairWorkflow();
      if (!workflow) {
        if (isCloudflareRuntime()) {
          throw new Error("SEARCH_INDEX_REPAIR Workflow binding is missing");
        }
        yield* repairSearchIndex(context.db, signal);
        return;
      }

      const requestedAt = new Date().toISOString();
      const instance = await workflow.create({
        id: crypto.randomUUID(),
        params: { requestedAt },
        retention: {
          successRetention: "1 day",
          errorRetention: "7 days",
        },
      });
      log.info("Workflow started", {
        instanceId: instance.id,
        requestId: getRequestId(context.headers),
      });
      yield* streamSearchIndexRepairWorkflow(instance, signal);
    },
  },
);

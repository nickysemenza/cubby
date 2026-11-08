import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  searchDestinationSchema,
  type SearchResultGroup,
} from "@cubby/schemas/search";
import type { requestEmbeddingRefreshInputSchema } from "@cubby/schemas/search";
import type { z } from "zod";

import {
  searchContract,
  searchStreamsContract,
} from "~/contracts/search.contract";
import { listEntities } from "~/entity/model/list-contracts";
import type { Database } from "~/server/db";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { listOperations } from "~/server/entity-kernel/list-operations";
import { loadEntityReadBinding } from "~/server/entity-kernel/list-operations";
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

/** Hydrate only returned groups, once per kind, through the canonical list projection. */
async function withSearchFacts(
  context: EntityKernelContext,
  groups: SearchResultGroup[],
): Promise<SearchResultGroup[]> {
  await Promise.all(
    listEntities.map(async (entity) => {
      const hits = groups
        .filter((group) => group.primary.entityKind === entity)
        .map((group) => group.primary);
      if (!hits.length) return;
      const fields = entityFieldModels[entity].fields;
      const binding = await loadEntityReadBinding(entity);
      const allowed = new Set(
        Object.keys(binding.repository.scaffold.readSchema.schema.shape),
      );
      const keys = [
        ...new Set(
          entitySummary[entity].searchFacts.flatMap((key) => {
            const field = fields.find((item) => item.key === key);
            return field
              ? [
                  ...(field.readKey ? [field.readKey] : []),
                  ...(field.display.readPath
                    ? [field.display.readPath.split(/[.[]/u)[0]]
                    : []),
                ]
              : [];
          }),
        ),
      ].filter((key): key is string => key !== undefined && allowed.has(key));
      if (!keys.length) return;
      const result = await (
        await listOperations(entity)
      ).listFields(
        context,
        {
          filters: { ids: hits.map((hit) => hit.id) },
          includeCount: false,
          pagination: { pageIndex: 0, pageSize: hits.length },
        },
        keys,
      );
      for (const hit of hits) {
        const row = result.items.find((item) => item.id === hit.id);
        if (row)
          hit.fieldFacts = searchDestinationSchema.shape.fieldFacts.parse(
            JSON.parse(JSON.stringify(row)),
          );
      }
    }),
  );
  return groups;
}

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
  grouped: async (context, input) =>
    withSearchFacts(context, await findGroupedSearchHits(context.db, input)),
  related: (context, input) => findRelatedSearchHits(context.db, input),
  relatedGrouped: async (context, input) => {
    const result = await findRelatedSearchGroups(context.db, input);
    return { ...result, groups: await withSearchFacts(context, result.groups) };
  },
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

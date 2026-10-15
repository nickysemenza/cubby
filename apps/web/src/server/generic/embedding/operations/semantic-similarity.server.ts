import {
  similarEntityPairs,
  type SimilarEntitiesInput,
  type SimilarEntitiesOut,
} from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import { findSimilarEntities } from "~/server/generic/embedding/repo/entity-embedding";
import { productionVectorStore } from "~/server/generic/embedding/semantic/vector-store";
import { getEmbeddingReadiness } from "~/server/generic/embedding/service/embedding-readiness.service";
import { hydrateSearchHitRefs } from "~/server/generic/search/service/search.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

/** Shared by explicit similarity requests and product relatedness. Readiness
 * gates candidate work; hydration removes deleted references and private IDs. */
export const findSimilarEntitiesWorkflow = bindWorkflow(
  workflow<Database, SimilarEntitiesInput>("search.similar")
    .call("pair", async (_, { input }) => {
      const pair = similarEntityPairs[input.pair];
      if (!pair) throw new Error(`Unsupported relatedness pair: ${input.pair}`);
      return pair;
    })
    .call("source", async ({ context }, { input, pair }) => ({
      entityKind: pair.source,
      entityId: await resolveOrThrow(context, pair.source, input.sourceId),
    }))
    .call("readiness", ({ context }, { source }) =>
      getEmbeddingReadiness(context, source),
    )
    .branch("matches", {
      when: async (_, { readiness }) => readiness === "ready",
      whenTrue: (branch) =>
        branch
          .call("candidates", (_, { input }) =>
            findSimilarEntities(productionVectorStore, input.source, {
              targetType: input.pair.target,
              limit: input.input.limit,
            }),
          )
          .call("hits", ({ context }, { candidates }) =>
            hydrateSearchHitRefs(context, candidates),
          )
          .output(({ candidates, hits }): SimilarEntitiesOut["results"] => {
            const hitByRef = new Map(
              hits.map(
                (hit) => [`${hit.entityKind}:${hit.entityId}`, hit] as const,
              ),
            );
            return candidates.flatMap((candidate) => {
              const hit = hitByRef.get(
                `${candidate.entityKind}:${candidate.entityId}`,
              );
              if (!hit) return [];
              const { entityId: _privateEntityId, ...entity } = hit;
              return [{ similarity: candidate.similarity, entity }];
            });
          }),
      whenFalse: (branch) =>
        branch.output((): SimilarEntitiesOut["results"] => []),
    })
    .output(({ input, pair, readiness, matches }): SimilarEntitiesOut => ({
      source: { entityKind: pair.source, entityId: input.sourceId },
      status: readiness,
      results: matches,
    })),
);

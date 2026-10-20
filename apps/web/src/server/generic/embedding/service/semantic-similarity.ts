import {
  similarEntityPairs,
  type SimilarEntitiesInput,
  type SimilarEntitiesOut,
} from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import { findSimilarEntities } from "~/server/generic/embedding/repo/entity-embedding";
import { getEmbeddingReadiness } from "~/server/generic/embedding/service/embedding-readiness.service";
import { productionVectorStore } from "~/server/generic/embedding/service/semantic/vector-store";
import { hydrateSearchHitRefs } from "~/server/generic/search/service/search.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

import { getSemanticEmbeddingConfig } from "./semantic/config";

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
          .call("candidates", ({ context }, { input }) =>
            findSimilarEntities(context, productionVectorStore, input.source, {
              targetType: input.pair.target,
              limit: input.input.limit,
              config: getSemanticEmbeddingConfig(),
            }),
          )
          .call("hits", ({ context }, { candidates }) =>
            hydrateSearchHitRefs(context, candidates.candidates),
          )
          .output(({ candidates, hits }) => {
            const hitByRef = new Map(
              hits.map(
                (hit) => [`${hit.entityKind}:${hit.entityId}`, hit] as const,
              ),
            );
            return {
              complete: candidates.complete,
              results: candidates.candidates.flatMap((candidate) => {
                const hit = hitByRef.get(
                  `${candidate.entityKind}:${candidate.entityId}`,
                );
                if (!hit) return [];
                const { entityId: _privateEntityId, ...entity } = hit;
                return [{ similarity: candidate.similarity, entity }];
              }),
            } satisfies Pick<SimilarEntitiesOut, "results" | "complete">;
          }),
      whenFalse: (branch) =>
        branch.output(() => ({ results: [], complete: false })),
    })
    .output(({ input, pair, readiness, matches }): SimilarEntitiesOut => ({
      source: { entityKind: pair.source, entityId: input.sourceId },
      status: readiness === "ready" && !matches.complete ? "stale" : readiness,
      complete: matches.complete,
      results: matches.results,
    })),
);

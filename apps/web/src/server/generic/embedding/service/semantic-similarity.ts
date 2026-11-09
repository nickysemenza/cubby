import {
  similarEntityPairs,
  type SimilarEntitiesInput,
  type SimilarEntitiesOut,
  type SearchableEntity,
} from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import { findSimilarEntities } from "~/server/generic/embedding/repo/entity-embedding";
import { getEmbeddingReadiness } from "~/server/generic/embedding/service/embedding-readiness.service";
import { productionVectorStore } from "~/server/generic/embedding/service/semantic/vector-store";
import { hydrateSearchHitRefs } from "~/server/generic/search/service/search.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { workflow } from "~/server/workflows/runtime/builder";
import { bindWorkflow } from "~/server/workflows/runtime/operation";

import { getSemanticEmbeddingConfig } from "./semantic/config";

/** Shared candidate/readiness/hydration path for public pair search and declared rails. */
export async function findSemanticNeighbours(
  db: Database,
  input: {
    entity: SearchableEntity;
    id: string;
    target: SearchableEntity;
    limit: number;
  },
): Promise<SimilarEntitiesOut> {
  const source = {
    entityKind: input.entity,
    entityId: await resolveOrThrow(db, input.entity, input.id),
  };
  const readiness = await getEmbeddingReadiness(db, source);
  if (readiness !== "ready")
    return {
      source: { entityKind: input.entity, entityId: input.id },
      status: readiness,
      complete: false,
      results: [],
    };
  const candidates = await findSimilarEntities(
    db,
    productionVectorStore,
    source,
    {
      targetType: input.target,
      limit: input.limit,
      config: getSemanticEmbeddingConfig(),
    },
  );
  const hits = await hydrateSearchHitRefs(db, candidates.candidates);
  const hitByRef = new Map(
    hits.map((hit) => [`${hit.entityKind}:${hit.entityId}`, hit]),
  );
  return {
    source: { entityKind: input.entity, entityId: input.id },
    status: candidates.complete ? "ready" : "stale",
    complete: candidates.complete,
    results: candidates.candidates.flatMap((candidate) => {
      const hit = hitByRef.get(`${candidate.entityKind}:${candidate.entityId}`);
      if (!hit) return [];
      const { entityId: _privateEntityId, ...entity } = hit;
      return [{ similarity: candidate.similarity, entity }];
    }),
  };
}

export const findSimilarEntitiesWorkflow = bindWorkflow(
  workflow<Database, SimilarEntitiesInput>("search.similar")
    .call("matches", ({ context }, { input }) => {
      const pair = similarEntityPairs[input.pair];
      if (!pair) throw new Error(`Unsupported relatedness pair: ${input.pair}`);
      return findSemanticNeighbours(context, {
        entity: pair.source,
        id: input.sourceId,
        target: pair.target,
        limit: input.limit,
      });
    })
    .output(({ matches }) => matches),
);

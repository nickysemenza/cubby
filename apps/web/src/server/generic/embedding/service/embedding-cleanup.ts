import { z } from "zod";

import { defineJobHandler } from "~/server/generic/jobs/service/jobs";

import {
  assertEmbeddingArtifactCanBeDeleted,
  recordEmbeddingDeletion,
} from "../repo/embedding-cleanup";
import {
  productionVectorStore,
  type VectorStorePort,
} from "./semantic/vector-store";

export function embeddingCleanupHandler(
  store: VectorStorePort = productionVectorStore,
) {
  return defineJobHandler(
    z.object({ artifactId: z.uuid() }),
    async (db, _claim, input) => {
      await assertEmbeddingArtifactCanBeDeleted(db, input.artifactId);
      const receipt = (await store.deleteByIds([input.artifactId])).get(
        input.artifactId,
      );
      if (!receipt) throw new Error("Vectorize returned no deletion receipt");
      return {
        page: {
          done: true,
          result: { artifactId: input.artifactId, deletionId: receipt },
        },
        publish: async (tx) => {
          await recordEmbeddingDeletion(tx, input.artifactId, receipt);
        },
      };
    },
  );
}

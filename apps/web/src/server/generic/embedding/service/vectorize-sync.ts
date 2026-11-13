import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { vectorPayloadHash } from "~/server/generic/embedding/repo/embedding-artifact";
import { recordEmbeddingDeletions } from "~/server/generic/embedding/repo/embedding-cleanup";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import {
  loadVectorDocument,
  retainedVectorArtifact,
  lockVectorDocument,
  stageVectorArtifact,
  recordVectorUpload,
  selectVisibleVector,
  retiredVectorIds,
  vectorLookupClaim,
} from "~/server/generic/embedding/repo/vectorize-sync";
import type { Claim, Pass, PassResult } from "~/server/kernel/api";
import { productionEmbeddingRefreshPort } from "~/server/workflows/background-tasks/embedding";

const syncCursor = z
  .object({ entityId: z.uuid(), sourceHash: z.string() })
  .nullable();
/** The Pass owns remote effects; repositories only publish their fenced receipts. */
export async function syncVectorize(
  db: Database,
  raw: Parameters<Pass["run"]>[1],
  claim: Claim,
  port = productionEmbeddingRefreshPort,
): Promise<PassResult> {
  const cursor = syncCursor.parse(raw);
  if (!port.configured())
    return {
      cursor: raw,
      done: false,
      availableAt: new Date(Date.now() + 3600000),
      waitCause: "provider_capacity",
    };
  if (cursor) {
    const doc = await loadVectorDocument(db, cursor);
    if (doc) {
      const config = port.config();
      const hash = await embeddingTextHash({
        entityKind: doc.entityKind,
        ...config,
        text: doc.semanticText,
      });
      const { embeddingAsk } =
        await import("~/server/generic/embedding/module");
      const { withAsk, queueAsk, claimExternalAsk, settleExternalAsk } =
        await import("~/server/kernel/api");
      const input = {
        entityId: doc.entityId,
        entityKind: doc.entityKind,
        sourceHash: doc.sourceHash,
        text: doc.semanticText,
      };
      const waiters = {
        record: { entity: doc.entityKind, id: doc.entityId },
        pass: {
          name: "vectorize.sync",
          key: `${doc.entityId}:${doc.sourceHash}`,
        },
      };
      const retained = await retainedVectorArtifact(db, doc.entityId, hash);
      if (
        retained?.submissionId ||
        retained?.artifactState === embeddingArtifactState.enum.selected
      ) {
        const id = await queueAsk(db, embeddingAsk, input, waiters);
        const [remote] = await port.vectorStore.getByIds([retained.id]);
        if (
          remote &&
          retained.vectorHash &&
          (await vectorPayloadHash(remote.values)) === retained.vectorHash
        ) {
          const claimed = await claimExternalAsk(
            db,
            { ...embeddingAsk, produce: undefined },
            { id, executor: "vectorize.lookup", leaseMs: 60000 },
          );
          const owned = claimed ?? (await vectorLookupClaim(db, id));
          if (owned?.token && owned.executor) {
            const { productionKernel } = await import("~/server/kernel/kernel");
            await settleExternalAsk(
              db,
              (await productionKernel()).registry,
              embeddingAsk,
              { id: owned.id, token: owned.token, executor: owned.executor },
              { output: remote.values, model: config.model },
              {
                validate: (tx) => lockVectorDocument(tx, doc),
                evidence: async () => [],
              },
            );
          }
        } else if (
          retained.artifactState === embeddingArtifactState.enum.selected
        )
          return {
            cursor: raw,
            done: false,
            availableAt: new Date(Date.now() + 3600000),
            waitCause: "provider_capacity",
          };
      }
      const values = await withAsk(
        db,
        {
          ...embeddingAsk,
          produce: async () => {
            const [output] = await port.embed([doc.semanticText], {
              db,
              feature: "entity_embedding",
              config,
            });
            if (!output)
              throw new Error("Embedding provider returned no vector");
            return { output, model: config.model };
          },
        },
        input,
        waiters,
      );
      const artifact = await claim.fenced((tx) =>
        stageVectorArtifact(tx, doc, hash, config),
      );
      if (
        artifact &&
        artifact.artifactState !== embeddingArtifactState.enum.selected
      ) {
        if (!artifact.submissionId) {
          const receipts = await port.vectorStore.upsert([
            { id: artifact.id, entityKind: doc.entityKind, values },
          ]);
          const receipt = receipts.get(artifact.id);
          if (!receipt) throw new Error("Vectorize returned no upload receipt");
          const vectorHash = await vectorPayloadHash(values);
          await claim.fenced((tx) =>
            recordVectorUpload(tx, artifact.id, receipt, vectorHash),
          );
        }
        const [observed] = await port.vectorStore.getByIds([artifact.id]);
        if (
          !observed ||
          (await vectorPayloadHash(observed.values)) !==
            (await vectorPayloadHash(values))
        )
          return {
            cursor: raw,
            done: false,
            availableAt: new Date(Date.now() + 5000),
            waitCause: "provider_capacity",
          };
        await claim.fenced((tx) => selectVisibleVector(tx, doc, artifact.id));
      }
    }
  }
  const retired = await retiredVectorIds(db);
  if (retired.length) {
    const receipts = await port.vectorStore.deleteByIds(retired);
    await claim.fenced((tx) =>
      recordEmbeddingDeletions(
        tx,
        [...receipts].map(([id, receipt]) => ({ id, receipt })),
      ),
    );
  }
  return { cursor: raw, done: retired.length < 100 };
}

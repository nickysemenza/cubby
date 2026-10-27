import type { Database } from "~/server/db/database";
import { vectorPayloadHash } from "~/server/generic/embedding/repo/embedding-artifact";
import {
  markEmbeddingArtifactsSubmitting,
  prepareEmbeddingDrainPage,
  publishEmbeddingDrainSelections,
  recordEmbeddingUploadReceipts,
  stageEmbeddingDrainArtifacts,
  type EmbeddingDrainPage,
  type EmbeddingUploadReceipt,
} from "~/server/generic/embedding/repo/embedding-drain";
import { EMBEDDING_REFRESH_TARGET } from "~/server/generic/embedding/repo/embedding-drain";
import {
  JobRetryableError,
  JobSupersededError,
} from "~/server/generic/jobs/errors";
import {
  dropWork,
  lockWork,
  postponeWork,
  type WorkItem,
} from "~/server/generic/jobs/repo/work-items";
import { defineDrain } from "~/server/generic/jobs/service/drain";
import type { JobContext } from "~/server/generic/jobs/types";
import {
  productionEmbeddingRefreshPort,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";

const PAGE_LIMIT = 100;
const REQUEST_ITEM_LIMIT = 2048;
const REQUEST_BYTES_LIMIT = 300_000;
const INPUT_BYTES_LIMIT = 8_192;
const VISIBILITY_POLL_MS = 5_000;
const VISIBILITY_DEADLINE_MS = 2 * 60_000;

type RefreshPage = EmbeddingDrainPage;

const checkSignal = (signal: AbortSignal) => {
  if (signal.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new JobSupersededError();
};

function uploadChunks<T extends { text: string }>(items: readonly T[]) {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    bytes = 0;
  };
  for (const item of items) {
    const size = new TextEncoder().encode(item.text).length;
    if (
      current.length &&
      (current.length >= REQUEST_ITEM_LIMIT ||
        bytes + size > REQUEST_BYTES_LIMIT)
    )
      flush();
    if (size > INPUT_BYTES_LIMIT) {
      flush();
      chunks.push([item]);
      continue;
    }
    current.push(item);
    bytes += size;
  }
  flush();
  return chunks;
}

async function prepareRefreshPage(
  port: EmbeddingRefreshPort,
  db: Database,
  items: readonly WorkItem[],
  context: JobContext,
) {
  if (!port.configured())
    throw new Error("Embedding provider or Vectorize binding is unavailable");
  const config = port.config();
  const page = await prepareEmbeddingDrainPage(db, items, config);
  const toCreate = page.uploads.some((entry) => !entry.artifactId);
  if (toCreate || page.stalePending.length)
    await context.fenced((tx) => stageEmbeddingDrainArtifacts(tx, items, page));

  const failures = new Map<WorkItem, unknown>();
  const submitted = page.submitted.filter(
    (entry) => entry.status === "poll" && entry.artifactId,
  );
  const observed = new Map<string, number[]>();
  if (submitted.length) {
    try {
      checkSignal(context.signal);
      for (const vector of await port.vectorStore.getByIds(
        submitted.map((entry) => entry.artifactId!),
      ))
        observed.set(vector.id, vector.values);
    } catch (error) {
      for (const entry of submitted) failures.set(entry.item, error);
    }
  }
  for (const entry of submitted) {
    if (failures.has(entry.item)) continue;
    const artifact = page.artifacts.find(
      (candidate) => candidate.id === entry.artifactId,
    );
    const values = observed.get(entry.artifactId!);
    if (
      values &&
      artifact?.vectorHash &&
      (await vectorPayloadHash(values)) === artifact.vectorHash
    ) {
      entry.vectorHash = artifact.vectorHash;
      entry.submissionId = artifact.submissionId ?? undefined;
      entry.status = "ready";
      continue;
    }
    const observedAt = artifact?.observedAt?.getTime();
    if (observedAt && Date.now() - observedAt > VISIBILITY_DEADLINE_MS) {
      failures.set(
        entry.item,
        new JobRetryableError(
          "Vectorize did not expose the uploaded artifact before its visibility deadline",
        ),
      );
      continue;
    }
    entry.pollUntil = new Date(Date.now() + VISIBILITY_POLL_MS);
  }

  for (const chunk of uploadChunks(
    page.uploads.filter(
      (entry) => entry.status === "upload" && entry.artifactId,
    ),
  )) {
    const current = new Set(
      await context.fenced((tx) =>
        lockWork(
          tx,
          chunk.map((entry) => entry.item),
        ),
      ),
    );
    for (const entry of chunk)
      if (!current.has(entry.item)) entry.status = "obsolete";
    const active = chunk.filter((entry) => current.has(entry.item));
    if (!active.length) continue;

    try {
      checkSignal(context.signal);
      const first = active[0]!;
      const vectors = await port.embed(
        active.map((entry) => entry.text),
        {
          db,
          feature: "entity_embedding",
          config,
          ...(active.length === 1 && first.ref ? { entity: first.ref } : {}),
        },
      );
      if (vectors.length !== active.length)
        throw new Error("Embedding provider returned an incomplete batch");
      const hashes = await Promise.all(vectors.map(vectorPayloadHash));
      checkSignal(context.signal);
      const uploadable = new Set(
        await context.fenced((tx) =>
          markEmbeddingArtifactsSubmitting(tx, active),
        ),
      );
      for (const entry of active)
        if (!uploadable.has(entry.item)) entry.status = "obsolete";
      const sending = active.filter((entry) => uploadable.has(entry.item));
      if (!sending.length) continue;
      const uploads = sending.map((entry) => ({
        id: entry.artifactId!,
        entityKind: entry.ref!.entityKind,
        values: vectors[active.indexOf(entry)]!,
      }));
      checkSignal(context.signal);
      const receipts = await port.vectorStore.upsert(uploads);
      const receiptEntries: EmbeddingUploadReceipt[] = [];
      for (const entry of sending) {
        const index = active.indexOf(entry);
        const submissionId = receipts.get(entry.artifactId!);
        if (!submissionId) {
          failures.set(
            entry.item,
            new Error("Vectorize returned no upload receipt"),
          );
          continue;
        }
        receiptEntries.push({
          entry,
          submissionId,
          vectorHash: hashes[index]!,
        });
      }
      if (receiptEntries.length)
        await context.fenced((tx) =>
          recordEmbeddingUploadReceipts(tx, receiptEntries),
        );
    } catch (error) {
      for (const entry of active) failures.set(entry.item, error);
    }
  }
  return { prepared: page, failed: failures };
}

export function embeddingRefreshHandler(
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
) {
  return defineDrain<RefreshPage>({
    limit: PAGE_LIMIT,
    prepare: (db, items, context) =>
      prepareRefreshPage(port, db, items, context),
    publish: async (tx, items, prepared) => {
      const postponed = items.filter(
        (item) => prepared.byItem.get(item)?.status === "poll",
      );
      for (const item of postponed) {
        const entry = prepared.byItem.get(item)!;
        await postponeWork(
          tx,
          [item],
          entry.pollUntil ?? new Date(Date.now() + VISIBILITY_POLL_MS),
        );
      }
      for (const item of items) {
        const entry = prepared.byItem.get(item);
        if (entry?.status === "missing")
          await dropWork(tx, EMBEDDING_REFRESH_TARGET, [item.ref]);
      }
      await publishEmbeddingDrainSelections(tx, items, prepared);
      return { retain: postponed };
    },
  });
}

import type { Database } from "~/server/db";
import {
  storeDrain,
  type BackgroundDrain,
} from "~/server/generic/background/drains";
import {
  assertEmbeddingArtifactCanBeDeleted,
  findDeletableEmbeddingArtifactIds,
  recordEmbeddingDeletion,
} from "~/server/generic/embedding/repo/embedding-cleanup";
import { embeddingCleanupStore } from "~/server/generic/embedding/repo/embedding-work";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import type { WorkItem } from "~/server/generic/jobs/repo/work-items";
import { defineDrain } from "~/server/generic/jobs/service/drain";
import type { JobContext } from "~/server/generic/jobs/types";

const PAGE_LIMIT = 100;
const EMBEDDING_BACKOFF = { baseMs: 60_000, maxMs: 15 * 60_000 };

type CleanupPage = {
  receipts: Map<WorkItem, string>;
};

const checkSignal = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason;
};

async function prepareCleanupPage(
  store: VectorStorePort,
  db: Database,
  items: readonly WorkItem[],
  context: JobContext,
) {
  const prepared: CleanupPage = { receipts: new Map() };
  const eligibleIds = await findDeletableEmbeddingArtifactIds(
    db,
    items.map((item) => item.ref),
  );
  const candidates = items.filter((item) => eligibleIds.has(item.ref));
  if (!candidates.length) return { prepared };

  const active = await context.fenced((tx) =>
    embeddingCleanupStore.lock(tx, candidates),
  );
  const activeSet = new Set(active);
  const deletable: WorkItem[] = [];
  for (const item of candidates) {
    if (!activeSet.has(item)) continue;
    if (await assertEmbeddingArtifactCanBeDeleted(db, item.ref))
      deletable.push(item);
  }
  if (!deletable.length) return { prepared };

  checkSignal(context.signal);
  let receipts: Map<string, string>;
  try {
    receipts = await store.deleteByIds(deletable.map((item) => item.ref));
  } catch (error) {
    return {
      prepared,
      failed: new Map(deletable.map((item) => [item, error])),
    };
  }
  for (const item of deletable) {
    const receipt = receipts.get(item.ref);
    if (receipt) prepared.receipts.set(item, receipt);
  }
  return {
    prepared,
    failed: new Map(
      deletable.flatMap((item) =>
        receipts.has(item.ref)
          ? []
          : [
              [
                item,
                new Error("Vectorize returned no deletion receipt"),
              ] as const,
            ],
      ),
    ),
  };
}

/** Deletes the physical vectors of retired artifacts. The artifacts are the debt. */
export function embeddingCleanupDrain(
  store: VectorStorePort = productionVectorStore,
): BackgroundDrain {
  const drain = storeDrain({
    name: "embedding.cleanup",
    store: embeddingCleanupStore,
    handler: defineDrain<CleanupPage>({
      store: embeddingCleanupStore,
      backoff: EMBEDDING_BACKOFF,
      limit: PAGE_LIMIT,
      prepare: (db, items, context) =>
        prepareCleanupPage(store, db, items, context),
      publish: async (tx, items, prepared) => {
        for (const item of items) {
          const receipt = prepared.receipts.get(item);
          if (receipt) await recordEmbeddingDeletion(tx, item.ref, receipt);
        }
      },
    }),
  });
  return {
    name: drain.name,
    page: (db, round) =>
      store.configured()
        ? drain.page(db, round)
        : Promise.resolve({ more: false, nextAt: null }),
  };
}

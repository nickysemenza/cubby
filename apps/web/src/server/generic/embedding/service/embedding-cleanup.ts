import type { Database } from "~/server/db";
import {
  assertEmbeddingArtifactCanBeDeleted,
  findDeletableEmbeddingArtifactIds,
  recordEmbeddingDeletion,
} from "~/server/generic/embedding/repo/embedding-cleanup";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { lockWork, type WorkItem } from "~/server/generic/jobs/repo/work-items";
import { defineDrain } from "~/server/generic/jobs/service/drain";
import type { JobContext } from "~/server/generic/jobs/types";

const PAGE_LIMIT = 100;

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
  if (!store.configured()) throw new Error("Vectorize binding is unavailable");
  const prepared: CleanupPage = { receipts: new Map() };
  const eligibleIds = await findDeletableEmbeddingArtifactIds(
    db,
    items.map((item) => item.ref),
  );
  const candidates = items.filter((item) => eligibleIds.has(item.ref));
  if (!candidates.length) return { prepared };

  const active = await context.fenced((tx) => lockWork(tx, candidates));
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

export function embeddingCleanupHandler(
  store: VectorStorePort = productionVectorStore,
) {
  return defineDrain<CleanupPage>({
    limit: PAGE_LIMIT,
    prepare: (db, items, context) =>
      prepareCleanupPage(store, db, items, context),
    publish: async (tx, items, prepared) => {
      const receipts = items.flatMap((item) => {
        const receipt = prepared.receipts.get(item);
        return receipt ? [{ item, receipt }] : [];
      });
      if (!receipts.length) return;
      const held = new Set(
        await lockWork(
          tx,
          receipts.map(({ item }) => item),
        ),
      );
      for (const { item, receipt } of receipts)
        if (held.has(item))
          await recordEmbeddingDeletion(tx, item.ref, receipt);
    },
  });
}

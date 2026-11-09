import type { Database } from "~/server/db";
import {
  rowDrain,
  type BackgroundDrain,
} from "~/server/generic/background/drains";
import {
  findDeletableEmbeddingArtifactIds,
  recordEmbeddingDeletions,
} from "~/server/generic/embedding/repo/embedding-cleanup";
import {
  embeddingCleanupDue,
  embeddingCleanupNext,
  embeddingCleanupStore,
  exhaustEmbeddingCleanup,
} from "~/server/generic/embedding/repo/embedding-work";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import type { DrainItem } from "~/server/generic/jobs/drain-store";
import type { JobContext } from "~/server/generic/jobs/types";

const PAGE_LIMIT = 100;
/** Deletions retry every five minutes: about 24 hours before one stops. */
const CLEANUP_MAX_ATTEMPTS = 288;
const EMBEDDING_BACKOFF = { baseMs: 60_000, maxMs: 15 * 60_000 };

type CleanupPage = {
  receipts: Map<DrainItem, string>;
};

const checkSignal = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason;
};

async function prepareCleanupPage(
  store: VectorStorePort,
  db: Database,
  items: readonly DrainItem[],
  context: Pick<JobContext, "signal" | "fenced">,
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
  const rechecked = await findDeletableEmbeddingArtifactIds(
    db,
    active.map((item) => item.ref),
  );
  const deletable = active.filter((item) => rechecked.has(item.ref));
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
  const page = rowDrain<CleanupPage>({
    store: embeddingCleanupStore,
    backoff: EMBEDDING_BACKOFF,
    limit: PAGE_LIMIT,
    maxAttempts: CLEANUP_MAX_ATTEMPTS,
    exhaust: exhaustEmbeddingCleanup,
    prepare: (db, items, context) =>
      prepareCleanupPage(store, db, items, context),
    publish: async (tx, items, prepared) => {
      await recordEmbeddingDeletions(
        tx,
        items.flatMap((item) => {
          const receipt = prepared.receipts.get(item);
          return receipt ? [{ id: item.ref, receipt }] : [];
        }),
      );
    },
  });
  const name = "embedding.cleanup";
  return {
    name,
    due: () => (store.configured() ? embeddingCleanupDue(name) : null),
    next: () => (store.configured() ? embeddingCleanupNext() : null),
    page: (db) => page(db),
  };
}

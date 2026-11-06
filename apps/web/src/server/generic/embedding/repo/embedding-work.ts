/**
 * What the embedding drains owe, held on the rows that own it: a `SearchDocument`
 * marked for refresh, and an `EntityEmbedding` retired without a deletion receipt.
 * Neither has a queue row. `generic/background/drains.ts` runs both, and each claim
 * is exclusive on the row.
 *
 * A refresh keeps two facts apart. The generation says which intent is owed, and a
 * re-mark advances it at any time. The lease says which page may pay the provider, and
 * only a claim, a settlement or its page's end changes it, so a re-mark during a paid
 * call cannot let a second page buy the same text.
 */
import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  min,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  repositoryQueries as getDb,
  repositoryAfterCommit,
} from "~/server/db/repository-access.boundary";
import { entityEmbedding, searchDocument } from "~/server/db/retained-tables";
import type { DrainStore } from "~/server/generic/jobs/drain-store";
import type { DrainItem } from "~/server/generic/jobs/drain-store";

const EMBEDDING_REFRESH_TARGET = "embedding.refresh";
const EMBEDDING_CLEANUP_TARGET = "embedding.cleanup";

/** A failed Vectorize deletion waits this long; a page never spins on an outage. */
const CLEANUP_RETRY_MS = 5 * 60_000;
/**
 * A claim outlasts the 15 minutes a consumer can run, so no sibling invocation (the
 * hourly cron beside the queue, or either side of a deploy) can buy the same embedding.
 * A crashed page's rows come free after this. Migration 0077 reserves this long too.
 */
const CLAIM_MS = 16 * 60_000;
const claimedUntil = () => sql`now() + ${CLAIM_MS} * interval '1 millisecond'`;

const item = (
  target: string,
  ref: string,
  ticket: number,
  attempts: number,
): DrainItem => ({ target, ref, ticket, priority: 0, attempts });

/**
 * Owe a fresh embedding for these sources. A page in flight keeps its lease: it can
 * no longer settle this intent, and no other page can pay until it ends.
 */
export async function markEmbeddingRefresh(
  db: Database,
  entityIds: readonly string[],
) {
  if (!entityIds.length) return;
  await getDb(db)
    .update(searchDocument)
    .set({
      embeddingDueAt: sql`now()`,
      embeddingGeneration: sql`${searchDocument.embeddingGeneration} + 1`,
      embeddingAttempts: 0,
      embeddingError: null,
    })
    .where(
      and(
        inArray(searchDocument.entityId, [...entityIds]),
        isNull(searchDocument.deletedAt),
      ),
    );
  await repositoryAfterCommit(db, async () =>
    (await import("~/server/workflows/background-tasks/publish")).wakeJobs({
      source: "embedding-refresh",
    }),
  );
}

/** Hold sources until `until` without spending an attempt: Vectorize is still indexing. */
export async function postponeEmbeddingRefresh(
  tx: Database,
  store: EmbeddingRefreshStore,
  items: readonly DrainItem[],
  until: Date,
) {
  for (const entry of items)
    await getDb(tx)
      .update(searchDocument)
      .set({ embeddingDueAt: until })
      .where(store.current(entry));
}

export type EmbeddingRefreshStore = DrainStore & {
  /** The page holds this source's lease and the intent it claimed is still the latest. */
  current(entry: DrainItem): SQL | undefined;
  /** Sources this page still holds, whatever was re-marked since: what its receipts may record. */
  holding(tx: Database, items: readonly DrainItem[]): Promise<DrainItem[]>;
  /** Give up what this page still holds; a re-mark it could not settle is then claimable. */
  release(db: Database): Promise<void>;
};

const leaseFree = () =>
  sql`coalesce(${searchDocument.embeddingLeaseUntil} <= now(), true)`;

/** One page's view of the refresh work; its `token` is that page's execution lease. */
export function embeddingRefreshStore(token: string): EmbeddingRefreshStore {
  const held = (entry: DrainItem) =>
    and(
      eq(searchDocument.entityId, entry.ref),
      eq(searchDocument.embeddingLeaseToken, token),
      isNull(searchDocument.deletedAt),
    );
  const current = (entry: DrainItem) =>
    and(held(entry), eq(searchDocument.embeddingGeneration, entry.ticket));
  const locked = (tx: Database, condition: SQL | undefined) =>
    getDb(tx)
      .select({
        ref: searchDocument.entityId,
        ticket: searchDocument.embeddingGeneration,
      })
      .from(searchDocument)
      .where(condition)
      .orderBy(asc(searchDocument.id))
      .for("update");
  const claimed = new Set<string>();
  return {
    current,
    claim: async (db, limit) => {
      const rows = await getDb(db)
        .update(searchDocument)
        .set({
          embeddingLeaseToken: token,
          embeddingLeaseUntil: claimedUntil(),
        })
        .where(
          inArray(
            searchDocument.id,
            getDb(db)
              .select({ id: searchDocument.id })
              .from(searchDocument)
              .where(
                and(
                  lte(searchDocument.embeddingDueAt, sql`now()`),
                  leaseFree(),
                  isNull(searchDocument.deletedAt),
                ),
              )
              .orderBy(asc(searchDocument.embeddingDueAt))
              .limit(limit)
              .for("update", { skipLocked: true }),
          ),
        )
        .returning({
          ref: searchDocument.entityId,
          ticket: searchDocument.embeddingGeneration,
          attempts: searchDocument.embeddingAttempts,
        });
      for (const row of rows) claimed.add(row.ref);
      return rows.map((row) =>
        item(EMBEDDING_REFRESH_TARGET, row.ref, row.ticket, row.attempts),
      );
    },
    lock: async (tx, items) => {
      if (!items.length) return [];
      const rows = await locked(tx, or(...items.map(current)));
      const live = new Set(rows.map((row) => `${row.ref}\0${row.ticket}`));
      return items.filter((entry) => live.has(`${entry.ref}\0${entry.ticket}`));
    },
    holding: async (tx, items) => {
      if (!items.length) return [];
      const rows = await locked(tx, or(...items.map(held)));
      const live = new Set(rows.map((row) => row.ref));
      return items.filter((entry) => live.has(entry.ref));
    },
    clear: async (tx, items) => {
      if (!items.length) return;
      await getDb(tx)
        .update(searchDocument)
        .set({
          embeddingDueAt: null,
          embeddingAttempts: 0,
          embeddingError: null,
          embeddingLeaseToken: null,
          embeddingLeaseUntil: null,
        })
        .where(or(...items.map(current)));
    },
    defer: async (tx, items, error, backoff) => {
      if (!items.length) return;
      await getDb(tx)
        .update(searchDocument)
        .set({
          embeddingAttempts: sql`${searchDocument.embeddingAttempts} + 1`,
          embeddingError: error.slice(0, 2000),
          embeddingDueAt: sql`now() + least(${backoff.maxMs}::bigint,
            ${backoff.baseMs}::bigint * (2 ^ least(${searchDocument.embeddingAttempts}, 20))::bigint) * interval '1 millisecond'`,
        })
        .where(or(...items.map(current)));
    },
    release: async (db) => {
      if (!claimed.size) return;
      await getDb(db)
        .update(searchDocument)
        .set({ embeddingLeaseToken: null, embeddingLeaseUntil: null })
        .where(
          and(
            inArray(searchDocument.entityId, [...claimed]),
            eq(searchDocument.embeddingLeaseToken, token),
          ),
        );
    },
    nextReadyAt: async (db) => {
      const [row] = await getDb(db)
        .select({
          at: sql<Date | null>`min(greatest(${searchDocument.embeddingDueAt}, ${searchDocument.embeddingLeaseUntil}))`.mapWith(
            searchDocument.embeddingDueAt,
          ),
        })
        .from(searchDocument)
        .where(
          and(
            isNotNull(searchDocument.embeddingDueAt),
            isNull(searchDocument.deletedAt),
          ),
        );
      return row?.at ?? null;
    },
  };
}

/** A retired or failed artifact that still has a physical vector. */
const cleanupOwed = () => sql`(
  ${entityEmbedding.deletionId} IS NULL
  AND ${entityEmbedding.artifactState} <> ${embeddingArtifactState.enum.selected}
  AND (${entityEmbedding.deletedAt} IS NOT NULL
    OR ${entityEmbedding.artifactState} IN (${embeddingArtifactState.enum.retired}, ${embeddingArtifactState.enum.failed}))
)`;

export const embeddingCleanupStore: DrainStore = {
  claim: async (db, limit) =>
    (
      await getDb(db)
        .update(entityEmbedding)
        .set({ deletionRetryAt: claimedUntil() })
        .where(
          inArray(
            entityEmbedding.id,
            getDb(db)
              .select({ id: entityEmbedding.id })
              .from(entityEmbedding)
              .where(
                and(
                  cleanupOwed(),
                  sql`coalesce(${entityEmbedding.deletionRetryAt} <= now(), true)`,
                ),
              )
              .orderBy(asc(entityEmbedding.id))
              .limit(limit)
              .for("update", { skipLocked: true }),
          ),
        )
        .returning({ ref: entityEmbedding.id })
    ).map((row) => item(EMBEDDING_CLEANUP_TARGET, row.ref, 0, 0)),
  lock: async (tx, items) => {
    if (!items.length) return [];
    const refs = items.map((entry) => entry.ref);
    const held = await getDb(tx)
      .select({ ref: entityEmbedding.id })
      .from(entityEmbedding)
      .where(
        and(
          sql`${entityEmbedding.id} = ANY(${uuidArrayParam(refs)})`,
          cleanupOwed(),
        ),
      )
      .orderBy(asc(entityEmbedding.id))
      .for("update");
    const current = new Set(held.map((row) => row.ref));
    return items.filter((entry) => current.has(entry.ref));
  },
  // Recording the deletion receipt is what settles an artifact.
  clear: async () => {},
  defer: async (tx, items) => {
    if (!items.length) return;
    await getDb(tx)
      .update(entityEmbedding)
      .set({ deletionRetryAt: new Date(Date.now() + CLEANUP_RETRY_MS) })
      .where(
        inArray(
          entityEmbedding.id,
          items.map((entry) => entry.ref),
        ),
      );
  },
  nextReadyAt: async (db) => {
    const [row] = await getDb(db)
      .select({ at: min(entityEmbedding.deletionRetryAt) })
      .from(entityEmbedding)
      .where(cleanupOwed());
    return row?.at ?? null;
  },
};

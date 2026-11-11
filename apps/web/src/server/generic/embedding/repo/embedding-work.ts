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
  count,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { requestedRows } from "~/server/db/helpers/requested";
import {
  repositoryQueries as getDb,
  repositoryAfterCommit,
} from "~/server/db/repository-access.boundary";
import { entityEmbedding, searchDocument } from "~/server/db/retained-tables";
import {
  transientRetryAt,
  type DrainItem,
  type DrainStore,
} from "~/server/generic/jobs/drain-store";

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
  failingSince: Date | null,
): DrainItem => ({ target, ref, ticket, priority: 0, attempts, failingSince });

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
      embeddingFailingSince: null,
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
  for (let offset = 0; offset < items.length; offset += 200) {
    const page = items.slice(offset, offset + 200);
    await getDb(tx).execute(sql`
      UPDATE "SearchDocument" SET "embeddingDueAt" = ${until.toISOString()}::timestamp, "embeddingError" = CASE WHEN "embeddingFailingSince" IS NULL THEN NULL ELSE "embeddingError" END
      FROM jsonb_to_recordset(${JSON.stringify(page.map((item) => ({ ref: item.ref, ticket: item.ticket })))}::jsonb) AS owed(ref uuid, ticket int)
      WHERE "SearchDocument"."entityId" = owed.ref AND "SearchDocument"."embeddingGeneration" = owed.ticket
        AND (${store.current(page)})`);
  }
}

export type EmbeddingRefreshStore = DrainStore & {
  /** The page holds this source's lease and the intent it claimed is still the latest. */
  current(entries: readonly DrainItem[]): SQL;
  /** Sources this page still holds, whatever was re-marked since: what its receipts may record. */
  holding(tx: Database, items: readonly DrainItem[]): Promise<DrainItem[]>;
  /** Give up what this page still holds; a re-mark it could not settle is then claimable. */
  release(db: Database): Promise<void>;
};

const leaseFree = () =>
  sql`coalesce(${searchDocument.embeddingLeaseUntil} <= now(), true)`;

/** One page's view of the refresh work; its `token` is that page's execution lease. */
export function embeddingRefreshStore(token: string): EmbeddingRefreshStore {
  const held = (entries: readonly DrainItem[]) => {
    const rows = requestedRows(
      entries.map(({ ref }) => ({ ref })),
      { ref: "uuid" },
      "held",
    );
    return and(
      sql`${searchDocument.entityId} = ANY(${uuidArrayParam(entries.map(({ ref }) => ref))})`,
      sql`EXISTS (SELECT 1 FROM ${rows.from} WHERE held.ref = ${searchDocument.entityId})`,
      eq(searchDocument.embeddingLeaseToken, token),
      isNull(searchDocument.deletedAt),
    );
  };
  const current = (entries: readonly DrainItem[]) => {
    const rows = requestedRows(
      entries.map(({ ref, ticket }) => ({ ref, ticket })),
      { ref: "uuid", ticket: "int" },
      "current_rows",
    );
    return sql`(${searchDocument.entityId} = ANY(${uuidArrayParam(entries.map(({ ref }) => ref))}) AND ${eq(searchDocument.embeddingLeaseToken, token)} AND ${isNull(searchDocument.deletedAt)} AND EXISTS (SELECT 1 FROM ${rows.from} WHERE current_rows.ref = ${searchDocument.entityId} AND current_rows.ticket = ${searchDocument.embeddingGeneration}))`;
  };
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
          failingSince: searchDocument.embeddingFailingSince,
        });
      for (const row of rows) claimed.add(row.ref);
      return rows.map((row) =>
        item(
          EMBEDDING_REFRESH_TARGET,
          row.ref,
          row.ticket,
          row.attempts,
          row.failingSince,
        ),
      );
    },
    lock: async (tx, items) => {
      if (!items.length) return [];
      const rows = await locked(tx, current(items));
      const live = new Set(rows.map((row) => `${row.ref}\0${row.ticket}`));
      return items.filter((entry) => live.has(`${entry.ref}\0${entry.ticket}`));
    },
    holding: async (tx, items) => {
      if (!items.length) return [];
      const rows = await locked(tx, held(items));
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
          embeddingFailingSince: null,
          embeddingLeaseToken: null,
          embeddingLeaseUntil: null,
        })
        .where(current(items));
    },
    defer: async (tx, items, error, backoff, transient) => {
      if (!items.length) return;
      await getDb(tx)
        .update(searchDocument)
        .set({
          embeddingAttempts: transient
            ? sql`${searchDocument.embeddingAttempts}`
            : sql`${searchDocument.embeddingAttempts} + 1`,
          embeddingFailingSince: sql`coalesce(${searchDocument.embeddingFailingSince}, now())`,
          embeddingError: error.slice(0, 2000),
          embeddingDueAt: transient
            ? transientRetryAt(searchDocument.embeddingFailingSince, backoff)
            : sql`now() + least(${backoff.maxMs}::bigint,
            ${backoff.baseMs}::bigint * (2 ^ least(${searchDocument.embeddingAttempts}, 20))::bigint) * interval '1 millisecond'`,
        })
        .where(current(items));
    },
    // A funding wait spends no attempt and ends any failure streak, so the
    // wait never counts toward the failing limit; its error stays visible
    // until the wait lifts or funding is reset.
    wait: async (tx, items, error, until) => {
      if (!items.length) return;
      await getDb(tx)
        .update(searchDocument)
        .set({
          embeddingError: error.slice(0, 2000),
          embeddingFailingSince: null,
          embeddingDueAt: until,
        })
        .where(current(items));
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
        .returning({
          ref: entityEmbedding.id,
          attempts: entityEmbedding.deletionAttempts,
          failingSince: entityEmbedding.deletionFailingSince,
        })
    ).map((row) =>
      item(
        EMBEDDING_CLEANUP_TARGET,
        row.ref,
        0,
        row.attempts,
        row.failingSince,
      ),
    ),
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
  // Deletions retry on a fixed interval; a transient failure spends no attempt.
  defer: async (tx, items, error, _backoff, transient) => {
    if (!items.length) return;
    await getDb(tx)
      .update(entityEmbedding)
      .set({
        deletionRetryAt: new Date(Date.now() + CLEANUP_RETRY_MS),
        deletionAttempts: transient
          ? sql`${entityEmbedding.deletionAttempts}`
          : sql`${entityEmbedding.deletionAttempts} + 1`,
        deletionFailingSince: sql`coalesce(${entityEmbedding.deletionFailingSince}, now())`,
        deletionError: error.slice(0, 2000),
      })
      .where(
        inArray(
          entityEmbedding.id,
          items.map((entry) => entry.ref),
        ),
      );
  },
};

/** Permit selection: refresh is due while a live document owes a vector and no page holds it. */
export const embeddingRefreshDue = (unit: string) =>
  sql`SELECT ${unit}::text AS unit, false AS demand, min(${searchDocument.embeddingDueAt}) AS since
    FROM ${searchDocument}
    WHERE ${searchDocument.embeddingDueAt} <= now() AND ${leaseFree()} AND ${searchDocument.deletedAt} IS NULL
    HAVING count(*) > 0`;
/**
 * A funding change ends embedding funding waits now: a waiting item holds an
 * error with no failure streak, which only `wait` leaves behind.
 */
const fundingWaitingEmbeddings = () =>
  and(
    sql`${searchDocument.embeddingDueAt} > now()`,
    isNull(searchDocument.embeddingFailingSince),
    isNotNull(searchDocument.embeddingError),
    isNull(searchDocument.deletedAt),
  );

export async function countFundingWaitingEmbeddings(db: Database) {
  const [row] = await getDb(db)
    .select({ n: count() })
    .from(searchDocument)
    .where(fundingWaitingEmbeddings());
  return row?.n ?? 0;
}

export async function wakeFundingWaitingEmbeddings(db: Database) {
  const woken = await getDb(db)
    .update(searchDocument)
    .set({ embeddingDueAt: sql`now()` })
    .where(fundingWaitingEmbeddings())
    .returning({ id: searchDocument.id });
  return woken.length;
}
export const embeddingRefreshNext = () =>
  sql`SELECT min(greatest(${searchDocument.embeddingDueAt}, ${searchDocument.embeddingLeaseUntil}))
    FROM ${searchDocument}
    WHERE ${searchDocument.embeddingDueAt} IS NOT NULL AND ${searchDocument.deletedAt} IS NULL`;

/** Permit selection: cleanup is due while a stopped artifact still holds a vector. */
export const embeddingCleanupDue = (unit: string) =>
  sql`SELECT ${unit}::text AS unit, false AS demand, now()::timestamp AS since
    -- includes-deleted: a deleted artifact still owes its vector deletion.
    WHERE EXISTS (SELECT 1 FROM ${entityEmbedding}
      WHERE ${cleanupOwed()} AND coalesce(${entityEmbedding.deletionRetryAt} <= now(), true))`;
export const embeddingCleanupNext = () =>
  sql`SELECT min(coalesce(${entityEmbedding.deletionRetryAt}, now()::timestamp)) FROM ${entityEmbedding} WHERE ${cleanupOwed()}`;

/**
 * A vector deletion that kept failing stops: its error stays on the artifact,
 * which Work lists as failed, and `infinity` keeps it out of selection.
 */
export async function exhaustEmbeddingCleanup(
  tx: Database,
  items: readonly DrainItem[],
  error: string,
) {
  if (!items.length) return;
  await getDb(tx)
    .update(entityEmbedding)
    .set({
      deletionRetryAt: sql`'infinity'::timestamp`,
      deletionAttempts: sql`${entityEmbedding.deletionAttempts} + 1`,
      deletionError: error.slice(0, 2000),
    })
    .where(
      inArray(
        entityEmbedding.id,
        items.map((entry) => entry.ref),
      ),
    );
}

/** A refresh that kept failing stops owing; its error and attempts stay for Work. */
export async function exhaustEmbeddingRefresh(
  tx: Database,
  items: readonly DrainItem[],
  error: string,
) {
  if (!items.length) return;
  await getDb(tx)
    .update(searchDocument)
    .set({
      embeddingDueAt: null,
      embeddingAttempts: sql`${searchDocument.embeddingAttempts} + 1`,
      embeddingError: error.slice(0, 2000),
      embeddingLeaseToken: null,
      embeddingLeaseUntil: null,
    })
    .where(
      inArray(
        searchDocument.entityId,
        items.map((entry) => entry.ref),
      ),
    );
}

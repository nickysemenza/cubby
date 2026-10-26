import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, withTransaction } from "~/server/db/helpers";
import { entityEmbedding, searchDocument } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  getOrphanedSearchDocumentRefs,
  type SearchDocumentCursor,
} from "~/server/generic/search/repo/search-document";

async function softDeleteEntityEmbeddingsTx(
  tx: DrizzleTransaction,
  entityKind: SearchableEntity,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  const changed = await tx
    .update(entityEmbedding)
    .set({ deletedAt: new Date(), artifactState: "retired" })
    .where(
      and(
        eq(entityEmbedding.entityKind, entityKind),
        inArray(entityEmbedding.entityId, entityIds),
        notDeleted(entityEmbedding),
      ),
    )
    .returning({ id: entityEmbedding.id });
  if (changed.length)
    await recordChange(tx, {
      kind: "projection",
      categories: ["search", "relatedData", "problems"],
    });
}

/** Revalidate persisted candidates and retire both artifacts atomically. */
export async function retireStillOrphanedSearchArtifacts(
  db: Database,
  refs: ReadonlyArray<{ entityKind: SearchableEntity; entityId: string }>,
): Promise<number> {
  if (refs.length === 0) return 0;
  return withTransaction(db, async (tx) => {
    const stillOrphaned = await getOrphanedSearchDocumentRefs(tx, refs);
    const byType = new Map<SearchableEntity, string[]>();
    for (const ref of stillOrphaned) {
      byType.set(ref.entityKind, [
        ...(byType.get(ref.entityKind) ?? []),
        ref.entityId,
      ]);
    }
    for (const [entityKind, ids] of byType) {
      // Orphan publication already owns its Job; acquiring search here would
      // reverse the ordinary search-before-orphans family order.
      await retireSearchArtifactsTx(tx, entityKind, ids);
    }
    return stillOrphaned.length;
  });
}

/**
 * Transactional removal cascade for every derived search artifact.
 *
 * `SearchDocument` and `EntityEmbedding` describe the same live entity at two
 * retrieval layers, so a removal must retire both rows atomically. Keep this
 * as the one removal-module entry point rather than teaching every delete and
 * merge path about the individual index tables.
 */
export async function softDeleteEntitySearchArtifactsTx(
  tx: DrizzleTransaction,
  entityKind: SearchableEntity,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  // Removal re-tickets the record's search mark through its trigger, so a
  // drain page prepared before it cannot republish the record (ADR 0021).
  await retireSearchArtifactsTx(tx, entityKind, entityIds);
}

async function retireSearchArtifactsTx(
  tx: DrizzleTransaction,
  entityKind: SearchableEntity,
  entityIds: string[],
): Promise<void> {
  await softDeleteEntityEmbeddingsTx(tx, entityKind, entityIds);
  const changed = await tx
    .update(searchDocument)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(searchDocument.entityKind, entityKind),
        inArray(searchDocument.entityId, entityIds),
        notDeleted(searchDocument),
      ),
    )
    .returning({ id: searchDocument.entityId });
  if (changed.length)
    await recordChange(tx, {
      kind: "projection",
      categories: ["search", "relatedData", "problems"],
    });
}

export async function getEntityEmbeddingDeletedAtForRef(
  db: Database | DrizzleTransaction,
  ref: SearchableEntityRef,
): Promise<Date | null | undefined> {
  const row = await unwrapDb(db).query.entityEmbedding.findFirst({
    where: and(
      eq(entityEmbedding.entityKind, ref.entityKind),
      eq(entityEmbedding.entityId, ref.entityId),
    ),
    columns: { deletedAt: true },
  });
  return row?.deletedAt;
}

const RECONCILE_PAGE_SIZE = 500;

/**
 * One keyset page of `SearchDocument` refs soft-deleted since `since`, for
 * the daily Vectorize reconcile: each ref's vector is safe to `deleteByIds`.
 *
 * includes-deleted: intentionally reads soft-deleted `SearchDocument` rows —
 * that is the whole point, finding vectors Vectorize should drop.
 * `EntityEmbedding.deletedAt` cannot stand in for this: an entity that was
 * embedded but never got a slim `EntityEmbedding` row (create-then-delete
 * before its first refresh, or a truncated table) has no soft-delete marker
 * there to find, only in `SearchDocument`.
 *
 * DISTINCT on (entityKind, entityId) and the NOT EXISTS guard both exist for
 * the same reason: `SearchDocument_live_entity_key` is a partial unique index
 * (`WHERE "deletedAt" IS NULL`), so `markSearchDocumentMissing` followed by a
 * later successful refresh inserts a second, live row for the same entity
 * rather than reviving the old one — the old row stays soft-deleted forever.
 * A naive "soft-deleted since X" scan would return that stale row and delete
 * a live entity's vector. NOT EXISTS excludes any entity that also has a live
 * twin; DISTINCT collapses the (rarer) case of two soft-deleted rows for one
 * entity into a single ref.
 */
export async function selectRecentlySoftDeletedSearchRefs(
  db: Database | DrizzleTransaction,
  options: { since: Date; cursor?: SearchDocumentCursor; limit?: number },
): Promise<{
  refs: Array<{ entityKind: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
}> {
  const limit = Math.min(
    Math.max(options.limit ?? RECONCILE_PAGE_SIZE, 1),
    RECONCILE_PAGE_SIZE,
  );
  const cursor = options.cursor
    ? sql`AND (sd."entityKind", sd."entityId") > (${options.cursor.entityKind}, ${options.cursor.entityId}::uuid)`
    : sql``;
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
  }>(sql`
    SELECT DISTINCT sd."entityKind", sd."entityId"::text AS "entityId"
    FROM "SearchDocument" sd
    WHERE sd."deletedAt" > ${options.since}
      AND NOT EXISTS (
        SELECT 1 FROM "SearchDocument" live
        WHERE live."entityKind" = sd."entityKind"
          AND live."entityId" = sd."entityId"
          AND live."deletedAt" IS NULL
      )
      ${cursor}
    ORDER BY sd."entityKind", sd."entityId"::text
    LIMIT ${limit}
  `);
  const last = result.rows.at(-1);
  return {
    refs: result.rows,
    nextCursor:
      last && result.rows.length === limit
        ? { entityKind: last.entityKind, entityId: last.entityId }
        : null,
  };
}

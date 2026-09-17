/**
 * Audit and repair the search index in one cancellable stream.
 *
 * Two scans, in this order: existing documents whose source is gone are
 * retired (projection and vector soft-deleted together); then every source
 * row whose document is missing or whose projected text drifted is rebuilt in
 * place. Embedding work is handed to the queue, whose handler skips anything
 * already current. The final counters are this run's findings and outcomes —
 * not a live claim about the index; the awaiting-work counts are that.
 */

import {
  type SearchIndexRepairCounters,
  type SearchIndexRepairEvent,
  searchIndexRepairPhases,
} from "@cubby/schemas/maintenance";
import { searchableEntities } from "@cubby/schemas/search";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import { retireStillOrphanedSearchArtifacts } from "~/server/repo/entity-embedding-cleanup";
import {
  getSearchDocumentOrphanPage,
  getSearchDocumentSourceRepairPage,
  refreshSearchDocuments,
  type SearchDocumentCursor,
} from "~/server/repo/search-document";
import { WorkflowCancelledError } from "~/server/workflow-runtime";

/** Workflow results persist at most one repair page of these refs. */
export type SearchIndexRepairRef = {
  entityType: (typeof searchableEntities)[number];
  entityId: string;
};

export const SEARCH_INDEX_REPAIR_PAGE_SIZE = 250;

export type SearchIndexRepairPageDelta = Partial<SearchIndexRepairCounters>;

export type SearchIndexRepairOrphanPage = {
  refs: SearchIndexRepairRef[];
  nextCursor: SearchDocumentCursor | null;
  delta: Pick<SearchIndexRepairCounters, "scanned" | "orphaned">;
};

export type SearchIndexRepairSourcePage = {
  refs: SearchIndexRepairRef[];
  nextCursor: SearchDocumentCursor | null;
  delta: Pick<SearchIndexRepairCounters, "scanned" | "missing" | "stale">;
};

export const createSearchIndexRepairCounters =
  (): SearchIndexRepairCounters => ({
    scanned: 0,
    orphaned: 0,
    missing: 0,
    stale: 0,
    retired: 0,
    rebuilt: 0,
    published: 0,
  });

/** Apply a completed page's persisted delta outside a retryable step. */
export const foldSearchIndexRepairCounters = (
  counters: SearchIndexRepairCounters,
  delta: SearchIndexRepairPageDelta,
): SearchIndexRepairCounters => ({
  scanned: counters.scanned + (delta.scanned ?? 0),
  orphaned: counters.orphaned + (delta.orphaned ?? 0),
  missing: counters.missing + (delta.missing ?? 0),
  stale: counters.stale + (delta.stale ?? 0),
  retired: counters.retired + (delta.retired ?? 0),
  rebuilt: counters.rebuilt + (delta.rebuilt ?? 0),
  published: counters.published + (delta.published ?? 0),
});

const cancelled = () =>
  new WorkflowCancelledError({ committed: true, effectsPending: false });

/** Keyset scans have no known total; report one more page while a cursor remains. */
const progress = (
  phase: (typeof searchIndexRepairPhases)[number],
  counters: SearchIndexRepairCounters,
  more: boolean,
): SearchIndexRepairEvent => ({
  type: "progress",
  phase,
  done: counters.scanned,
  total: counters.scanned + (more ? SEARCH_INDEX_REPAIR_PAGE_SIZE : 0),
  counters: { ...counters },
});

/** Select one durable orphan page. The returned refs are Workflow-safe data. */
export async function selectSearchIndexRepairOrphanPage(
  db: Database,
  cursor?: SearchDocumentCursor,
): Promise<SearchIndexRepairOrphanPage> {
  const page = await getSearchDocumentOrphanPage(db, {
    cursor,
    pageSize: SEARCH_INDEX_REPAIR_PAGE_SIZE,
  });
  return {
    refs: page.refs,
    nextCursor: page.nextCursor,
    delta: {
      scanned: page.scannedCount,
      orphaned: page.orphanedCount,
    },
  };
}

/**
 * Retire only refs that are still orphaned when this persisted page applies.
 *
 * Selection and application intentionally run in separate Workflow steps, so
 * this revalidates liveness in the same transaction as retiring both search
 * artifacts. A source restored after selection therefore stays searchable.
 */
export async function applySearchIndexRepairOrphanPage(
  db: Database,
  refs: ReadonlyArray<SearchIndexRepairRef>,
): Promise<Pick<SearchIndexRepairCounters, "retired">> {
  return { retired: await retireStillOrphanedSearchArtifacts(db, refs) };
}

/** Select one durable missing/stale-source page. */
export async function selectSearchIndexRepairSourcePage(
  db: Database,
  cursor?: SearchDocumentCursor,
): Promise<SearchIndexRepairSourcePage> {
  const page = await getSearchDocumentSourceRepairPage(
    db,
    [...searchableEntities],
    { cursor, pageSize: SEARCH_INDEX_REPAIR_PAGE_SIZE },
  );
  return {
    refs: page.refs,
    nextCursor: page.nextCursor,
    delta: {
      scanned: page.scannedCount,
      missing: page.missingCount,
      stale: page.staleCount,
    },
  };
}

/** Refresh exactly the refs persisted by a source-selection page. */
export async function applySearchIndexRepairSourcePage(
  db: Database,
  refs: ReadonlyArray<SearchIndexRepairRef>,
): Promise<Pick<SearchIndexRepairCounters, "rebuilt">> {
  const refreshed = await refreshSearchDocuments(db, refs);
  return {
    rebuilt: refreshed.filter((result) => result.status === "upserted").length,
  };
}

/**
 * Publish the same persisted refs after their projection step succeeds.
 *
 * The count is logical work accepted for publication, not a count of Queue
 * deliveries (which may be retried independently by the transport).
 */
export async function publishSearchIndexRepairSourcePage(
  db: Database,
  refs: ReadonlyArray<SearchIndexRepairRef>,
  requestedAt: string,
): Promise<Pick<SearchIndexRepairCounters, "published">> {
  if (refs.length === 0) return { published: 0 };
  await publishBackgroundTasks(
    db,
    refs.map((ref) => ({
      kind: "entity-embedding.refresh" as const,
      requestedAt,
      entityType: ref.entityType,
      entityId: ref.entityId,
    })),
    { source: "maintenance.repair-search-index" },
  );
  return { published: refs.length };
}

export async function* repairSearchIndex(
  db: Database,
  signal?: AbortSignal,
): AsyncGenerator<SearchIndexRepairEvent, void> {
  let counters = createSearchIndexRepairCounters();
  const requestedAt = new Date().toISOString();

  // Phase 1: documents whose source no longer exists.
  let orphanCursor: SearchDocumentCursor | null = null;
  do {
    if (signal?.aborted) throw cancelled();
    const page = await selectSearchIndexRepairOrphanPage(
      db,
      orphanCursor ?? undefined,
    );
    counters = foldSearchIndexRepairCounters(counters, page.delta);
    const applied = await applySearchIndexRepairOrphanPage(db, page.refs);
    counters = foldSearchIndexRepairCounters(counters, applied);
    orphanCursor = page.nextCursor;
    yield progress("orphans", counters, orphanCursor !== null);
  } while (orphanCursor);

  // Phase 2: source rows with a missing or stale projection.
  let sourceCursor: SearchDocumentCursor | null = null;
  do {
    if (signal?.aborted) throw cancelled();
    const page = await selectSearchIndexRepairSourcePage(
      db,
      sourceCursor ?? undefined,
    );
    counters = foldSearchIndexRepairCounters(counters, page.delta);
    const applied = await applySearchIndexRepairSourcePage(db, page.refs);
    counters = foldSearchIndexRepairCounters(counters, applied);
    const published = await publishSearchIndexRepairSourcePage(
      db,
      page.refs,
      requestedAt,
    );
    counters = foldSearchIndexRepairCounters(counters, published);
    sourceCursor = page.nextCursor;
    yield progress("sources", counters, sourceCursor !== null);
  } while (sourceCursor);

  yield { type: "done", result: counters };
}

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
import { retireOrphanedSearchArtifacts } from "~/server/repo/entity-embedding-cleanup";
import {
  getSearchDocumentOrphanPage,
  getSearchDocumentSourceRepairPage,
  refreshSearchDocuments,
} from "~/server/repo/search-document";
import { WorkflowCancelledError } from "~/server/workflow-runtime";

const emptyCounters = (): SearchIndexRepairCounters => ({
  scanned: 0,
  orphaned: 0,
  missing: 0,
  stale: 0,
  retired: 0,
  rebuilt: 0,
  published: 0,
});

const cancelled = () =>
  new WorkflowCancelledError({ committed: true, effectsPending: false });

/** Keyset scans have no known total; report one more page while a cursor remains. */
const PAGE_SIZE = 250;
const progress = (
  phase: (typeof searchIndexRepairPhases)[number],
  counters: SearchIndexRepairCounters,
  more: boolean,
): SearchIndexRepairEvent => ({
  type: "progress",
  phase,
  done: counters.scanned,
  total: counters.scanned + (more ? PAGE_SIZE : 0),
  counters: { ...counters },
});

export async function* repairSearchIndex(
  db: Database,
  signal?: AbortSignal,
): AsyncGenerator<SearchIndexRepairEvent, void> {
  const counters = emptyCounters();
  const requestedAt = new Date().toISOString();

  // Phase 1: documents whose source no longer exists.
  let orphanCursor: Awaited<
    ReturnType<typeof getSearchDocumentOrphanPage>
  >["nextCursor"] = null;
  do {
    if (signal?.aborted) throw cancelled();
    const page = await getSearchDocumentOrphanPage(db, {
      cursor: orphanCursor ?? undefined,
    });
    counters.scanned += page.scannedCount;
    counters.orphaned += page.orphanedCount;
    if (page.refs.length > 0) {
      await retireOrphanedSearchArtifacts(db, page.refs);
      counters.retired += page.refs.length;
    }
    orphanCursor = page.nextCursor;
    yield progress("orphans", counters, orphanCursor !== null);
  } while (orphanCursor);

  // Phase 2: source rows with a missing or stale projection.
  let sourceCursor: Awaited<
    ReturnType<typeof getSearchDocumentSourceRepairPage>
  >["nextCursor"] = null;
  do {
    if (signal?.aborted) throw cancelled();
    const page = await getSearchDocumentSourceRepairPage(
      db,
      [...searchableEntities],
      { cursor: sourceCursor ?? undefined },
    );
    counters.scanned += page.scannedCount;
    counters.missing += page.missingCount;
    counters.stale += page.staleCount;
    if (page.refs.length > 0) {
      const refreshed = await refreshSearchDocuments(db, page.refs);
      counters.rebuilt += refreshed.filter(
        (result) => result.status === "upserted",
      ).length;
      const receipt = await publishBackgroundTasks(
        db,
        page.refs.map((ref) => ({
          kind: "entity-embedding.refresh" as const,
          requestedAt,
          entityType: ref.entityType,
          entityId: ref.entityId,
        })),
        { source: "maintenance.repair-search-index" },
      );
      counters.published += receipt.count;
    }
    sourceCursor = page.nextCursor;
    yield progress("sources", counters, sourceCursor !== null);
  } while (sourceCursor);

  yield { type: "done", result: counters };
}

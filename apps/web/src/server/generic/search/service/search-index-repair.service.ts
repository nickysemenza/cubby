import {
  type SearchIndexRepairCounters,
  type SearchIndexRepairEvent,
} from "@cubby/schemas/maintenance";
import { sleep } from "@cubby/shared/retry";

import type { Database } from "~/server/db";
import { WorkflowCancelledError } from "~/server/workflows/runtime";

import {
  scheduleSearchRepair,
  readSearchRepairProgress,
} from "../repo/search-index-repair";

const createSearchIndexRepairCounters = (): SearchIndexRepairCounters => ({
  scanned: 0,
  orphaned: 0,
  missing: 0,
  stale: 0,
  retired: 0,
  rebuilt: 0,
  published: 0,
});

/** Explicit repair requests the hourly pass; disconnecting the stream leaves its cursor intact. */
export async function* repairSearchIndex(
  db: Database,
  signal?: AbortSignal,
): AsyncGenerator<SearchIndexRepairEvent, void> {
  await scheduleSearchRepair(db);
  while (true) {
    if (signal?.aborted)
      throw new WorkflowCancelledError({
        committed: true,
        effectsPending: true,
      });
    const { pending, error } = await readSearchRepairProgress(db);
    if (error) throw new Error(error);
    const counters = createSearchIndexRepairCounters();
    const done = !pending;
    if (done) {
      yield { type: "done", result: counters };
      return;
    }
    yield {
      type: "progress",
      phase: "sources",
      done: counters.scanned,
      total: counters.scanned + 1,
      counters,
    };
    await sleep(500);
  }
}

import {
  searchIndexRepairCountersSchema,
  type SearchIndexRepairCounters,
  type SearchIndexRepairEvent,
} from "@cubby/schemas/maintenance";
import { sleep } from "@cubby/shared/retry";

import type { Database } from "~/server/db";
import { WorkflowCancelledError } from "~/server/workflows/runtime";

import {
  scheduleSearchRepair,
  readSearchRepairJobs,
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

/** Explicit repair schedules the ordinary family Jobs; the stream only reads them. */
export async function* repairSearchIndex(
  db: Database,
  signal?: AbortSignal,
): AsyncGenerator<SearchIndexRepairEvent, void> {
  const ids = await scheduleSearchRepair(db);
  while (true) {
    if (signal?.aborted)
      throw new WorkflowCancelledError({
        committed: true,
        effectsPending: true,
      });
    const executions = await readSearchRepairJobs(db, ids);
    if (executions.length !== ids.length)
      throw new Error("Search repair Job disappeared");
    const stopped = executions.find((execution) =>
      ["failed", "paused", "cancelled"].includes(execution.state),
    );
    if (stopped)
      throw new Error(
        stopped.error ?? `Search repair ${stopped.key} is ${stopped.state}`,
      );
    const counters = createSearchIndexRepairCounters();
    for (const execution of executions) {
      const parsed = searchIndexRepairCountersSchema
        .partial()
        .safeParse(execution.result);
      if (!parsed.success) continue;
      for (const key of searchIndexRepairCountersSchema.keyof().options)
        counters[key] += parsed.data[key] ?? 0;
    }
    const done = executions.every(
      (execution) => execution.state === "completed",
    );
    if (done) {
      yield { type: "done", result: counters };
      return;
    }
    const orphans = executions.find(
      (execution) => execution.key === "refresh:orphans",
    );
    yield {
      type: "progress",
      phase: orphans?.state === "completed" ? "sources" : "orphans",
      done: counters.scanned,
      total: counters.scanned + 1,
      counters,
    };
    await sleep(500);
  }
}

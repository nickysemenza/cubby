import { type SearchIndexRepairEvent } from "@cubby/schemas/maintenance";
import { sleep } from "@cubby/shared/retry";

import type { Database } from "~/server/db";
import { WorkflowCancelledError } from "~/server/workflows/runtime/execute";

import {
  scheduleSearchRepair,
  readSearchRepairProgress,
} from "../repo/search-index-repair";

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
    const pass = await readSearchRepairProgress(db);
    if (pass.error) throw new Error(pass.error);
    const result = {
      processedRecords: pass.processedRecords,
      failedPages: pass.failedPages,
      finishedAt: pass.finishedAt,
      cleanAt: pass.cleanAt,
    };
    if (!pass.running) {
      yield { type: "done", result };
      return;
    }
    yield { type: "status", target: pass.target, result };
    await sleep(500);
  }
}

import { runEntityId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import type { Fenced } from "~/server/generic/jobs/types";
/** Ended Runs ask for their summary through their fields scope. */
import { defineModule } from "~/server/kernel/api";

import {
  listOwedRunSummaries,
  runEndedAtGeneration,
  runSummaryDueSql,
} from "../repo/run-summary";

export const runKernelModule = defineModule({ name: "run" });

export const runSummaryDrain: BackgroundDrain = {
  name: "run-summary",
  label: () => "Run summaries",
  due: runSummaryDueSql,
  next: () => null,
  async page(db) {
    const owed = await listOwedRunSummaries(db, 20);
    const { reconcileNow } = await import("~/server/kernel/api");
    await reconcileNow(
      db,
      owed.map((row) => ({ kind: "fields", key: `run:${row.subjectRunId}` })),
    );
    return { claimed: owed.length };
  },
};

export async function writeRunSummary(
  db: Database,
  task: { subjectRunId: string; endedAt: string },
  _fenced: Fenced,
): Promise<"succeeded" | "skipped"> {
  if (
    !(await runEndedAtGeneration(
      db,
      runEntityId.parse(task.subjectRunId),
      task.endedAt,
    ))
  )
    return "skipped";
  await (
    await import("~/server/kernel/api")
  ).reconcileNow(db, [{ kind: "fields", key: `run:${task.subjectRunId}` }]);
  return "succeeded";
}

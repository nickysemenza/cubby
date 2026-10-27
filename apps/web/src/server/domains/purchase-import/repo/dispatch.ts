import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { jobState } from "@cubby/schemas/job";
import {
  purchaseAgentEvent,
  type PurchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import { runStatus } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

/** Commit handoff intent with admission. Retries retain one operation identity. */
export async function dispatchRunEvent(
  db: RepositoryQueryInput,
  submitted: PurchaseAgentEvent,
) {
  const event = purchaseAgentEvent.parse(submitted);
  const saved = await enqueueJob(db, {
    key: `purchase-dispatch:${event.runId}:${event.type}:${event.eventId}`,
    kind: "purchase.dispatch",
    runId: event.runId,
    input: event,
  });
  await runAfterCommit(db, () => wakeJobs({ source: "purchase.dispatch" }));
  return saved;
}

export async function dispatchStartedRun(
  db: RepositoryQueryInput,
  run: { id: string; eventId: string; purpose: string },
): Promise<"running"> {
  await dispatchRunEvent(db, {
    version: 1,
    runId: run.id,
    purpose: agentImportRunPurpose.parse(run.purpose),
    eventId: run.eventId,
    generation: run.eventId,
    type: "start_or_resume",
  });
  return "running";
}

/** Only the current unstarted generation can inherit terminal Job diagnostics. */
export async function reconcilePurchaseDispatches(db: Database) {
  await getDb(db)
    .execute(sql`UPDATE "Run" r SET status=${runStatus.enum.dispatch_failed}, "failureCode"=${runStatus.enum.dispatch_failed},
    "dispatchError"=j.error, "endedAt"=now(), "updatedAt"=now()
    FROM "Job" j WHERE j.kind='purchase.dispatch' AND j.state=${jobState.enum.failed} AND j."runId"=r.id
      AND j.input->>'type'='start_or_resume' AND j.input->>'eventId'=r."dispatchEventId"
      AND r.status=${runStatus.enum.running} AND r."coordinatorStartedAt" IS NULL AND r."retiredAt" IS NULL AND r."deletedAt" IS NULL`);
}

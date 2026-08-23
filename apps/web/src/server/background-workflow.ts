/**
 * Durable, page-at-a-time maintenance workflows.
 *
 * The batch is the workflow record; one pending coordinator is the barrier
 * between pages. Child jobs may complete in any order, but only the final
 * terminal outcome promotes and dispatches the following coordinator.
 */
import type {
  BackgroundBatchRef,
  BackgroundBatchSource,
  BackgroundJobKind,
} from "@cubby/schemas/background-jobs";
import {
  dispatchQueuedBackgroundJob,
  dispatchQueuedBackgroundJobs,
} from "~/server/background-dispatch";
import type { Database } from "~/server/db";
import {
  appendBackgroundJobsToWorkflow,
  type CreateBackgroundJobInput,
  promotePendingBackgroundWorkflowContinuation,
  startOrReuseBackgroundWorkflow,
} from "~/server/repo/background-jobs";

export async function startOrReuseWorkflow(
  db: Database,
  input: {
    kind: BackgroundJobKind;
    source: BackgroundBatchSource;
    dedupeKey: string;
    metadata: unknown;
    initialJobs: CreateBackgroundJobInput[];
  },
): Promise<{ batch: BackgroundBatchRef; reused: boolean }> {
  const started = await startOrReuseBackgroundWorkflow(db, {
    kind: input.kind,
    source: input.source,
    dedupeKey: input.dedupeKey,
    metadata: input.metadata,
    initialJobs: input.initialJobs,
  });
  if (started.jobIds.length > 0) {
    await dispatchQueuedBackgroundJobs(db, {
      batchId: started.batch.id,
      jobIds: started.jobIds,
      batchKind: input.kind,
    });
  }
  return { batch: started.batch, reused: started.reused };
}

const backgroundWorkflowKinds = new Set<BackgroundJobKind>([
  "entity-embedding.backfill.coordinator",
  "search-document.repair.coordinator",
]);

export const isBackgroundWorkflowKind = (
  kind: BackgroundJobKind | undefined,
): boolean => kind != null && backgroundWorkflowKinds.has(kind);

/**
 * Append this page's work and, when another page exists, one *pending*
 * coordinator. `appendBackgroundJobsToWorkflow` updates the auditable batch
 * summary in the same transaction; retry state remains owned by the opaque
 * coordinator payload.
 */
export async function continueWorkflow(
  db: Database,
  input: {
    batchId: string;
    batchKind: BackgroundJobKind;
    metadata: unknown;
    children: CreateBackgroundJobInput[];
    continuation?: CreateBackgroundJobInput | null;
  },
): Promise<void> {
  const { childJobIds } = await appendBackgroundJobsToWorkflow(db, {
    batchId: input.batchId,
    children: input.children,
    continuation: input.continuation,
    metadata: input.metadata,
  });
  // `appendBackgroundJobsToWorkflow` returns only queued child ids; its pending
  // continuation is deliberately invisible to delivery until the barrier opens.
  if (childJobIds.length > 0) {
    await dispatchQueuedBackgroundJobs(db, {
      batchId: input.batchId,
      jobIds: childJobIds,
      batchKind: input.batchKind,
    });
  }
}

/**
 * Called after every terminal job outcome. The repo primitive performs the
 * active-sibling check and promotion atomically; redispatch sees only the one
 * newly-queued continuation.
 */
export async function advanceWorkflowIfReady(
  db: Database,
  batchId: string,
): Promise<void> {
  const promoted = await promotePendingBackgroundWorkflowContinuation(
    db,
    batchId,
  );
  if (promoted) {
    await dispatchQueuedBackgroundJob(db, {
      batchId,
      jobId: promoted.jobId,
      batchKind: promoted.kind,
    });
  }
}

/**
 * Durable, page-at-a-time maintenance workflows.
 *
 * The batch is the workflow record; one pending coordinator is the barrier
 * between pages. Child jobs may complete in any order, but only the final
 * terminal outcome promotes and dispatches the following coordinator.
 */
import type {
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
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

type StartWorkflowInput = {
  kind: BackgroundJobKind;
  source: BackgroundBatchSource;
  dedupeKey: string;
  metadata: unknown;
  initialJobs: CreateBackgroundJobInput[];
};

const startOrReuseWorkflowDefinition = workflow<Database, StartWorkflowInput>(
  "background-workflow.startOrReuse",
)
  .commit(
    "startOrReuse",
    async ({ context }, { input }) =>
      await startOrReuseBackgroundWorkflow(context, input),
  )
  .effect("dispatchInitial", async ({ context }, { startOrReuse, input }) => {
    if (startOrReuse.jobIds.length === 0) return;
    await dispatchQueuedBackgroundJobs(context, {
      batchId: startOrReuse.batch.id,
      jobIds: startOrReuse.jobIds,
      batchKind: input.kind,
    });
  })
  .output(({ startOrReuse }) => ({
    batch: startOrReuse.batch,
    reused: startOrReuse.reused,
  }));

export const startOrReuseWorkflow = bindWorkflow(
  startOrReuseWorkflowDefinition,
  (db: Database, input: StartWorkflowInput) => ({ context: db, input }),
);

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
type ContinueWorkflowInput = {
  batchId: string;
  batchKind: BackgroundJobKind;
  metadata: unknown;
  children: CreateBackgroundJobInput[];
  continuation?: CreateBackgroundJobInput | null;
};

const continueWorkflowDefinition = workflow<Database, ContinueWorkflowInput>(
  "background-workflow.continue",
)
  .commit(
    "append",
    async ({ context }, { input }) =>
      await appendBackgroundJobsToWorkflow(context, input),
  )
  .effect("dispatchChildren", async ({ context }, { append, input }) => {
    // Pending continuation IDs stay behind the active-child barrier.
    if (append.childJobIds.length === 0) return;
    await dispatchQueuedBackgroundJobs(context, {
      batchId: input.batchId,
      jobIds: append.childJobIds,
      batchKind: input.batchKind,
    });
  })
  .output(() => undefined);

export const continueWorkflow = bindWorkflow(
  continueWorkflowDefinition,
  (db: Database, input: ContinueWorkflowInput) => ({ context: db, input }),
);

/**
 * Called after every terminal job outcome. The repo primitive performs the
 * active-sibling check and promotion atomically; redispatch sees only the one
 * newly-queued continuation.
 */
const advanceWorkflowDefinition = workflow<Database, string>(
  "background-workflow.advanceIfReady",
)
  .commit(
    "promote",
    async ({ context }, { input }) =>
      await promotePendingBackgroundWorkflowContinuation(context, input),
  )
  .effect("dispatchPromoted", async ({ context }, { promote, input }) => {
    if (!promote) return;
    await dispatchQueuedBackgroundJob(context, {
      batchId: input,
      jobId: promote.jobId,
      batchKind: promote.kind,
    });
  })
  .output(() => undefined);

export const advanceWorkflowIfReady = bindWorkflow(
  advanceWorkflowDefinition,
  (db: Database, batchId: string) => ({ context: db, input: batchId }),
);

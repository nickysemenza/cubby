import { AsyncLocalStorage } from "node:async_hooks";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import type { JobContext } from "~/server/generic/jobs/types";

type ExecutionFence = Readonly<{
  /** The executing Job's fence, handed in by the handler that owns the claim. */
  job: Pick<JobContext, "fence" | "check">;
}>;
type WorkflowExecution = ExecutionFence &
  Readonly<{ runId: string; attempt: number; database?: Database }>;
const execution = new AsyncLocalStorage<ExecutionFence>();
export const hasWorkflowExecution = () =>
  execution.getStore() !== undefined || currentJobExecution() !== undefined;

export class WorkflowInterruptedError extends Error {
  constructor(readonly reason: "cancelled" | "superseded") {
    super(`Workflow execution interrupted: ${reason}`);
  }
}
export function workflowInterruption(
  error: UnparsedError,
): WorkflowInterruptedError | JobSupersededError | null {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (
      error instanceof WorkflowInterruptedError ||
      error instanceof JobSupersededError
    )
      return error;
    seen.add(error);
    error = error.cause;
  }
  return null;
}
export const isWorkflowInterrupted = (error: UnparsedError): boolean =>
  workflowInterruption(error) !== null;
export const withWorkflowExecution = <T>(
  identity: WorkflowExecution,
  work: () => Promise<T>,
) => execution.run(identity, work);
/** A standalone Job that calls providers outside a Run scopes its own fence, so a lost lease stops the next paid request. */
export const withJobFence = <T>(
  job: ExecutionFence["job"],
  work: () => Promise<T>,
) => execution.run({ job }, work);

/** Check current ownership before starting another provider batch; no connection spans inference. */
export async function assertWorkflowCurrent(): Promise<void> {
  await execution.getStore()?.job.check();
}

/** Effect ownership comes solely from the current Job token and generation. */
export async function assertWorkflowEffect(db: Database): Promise<void> {
  await execution.getStore()?.job.fence(db);
}

import { AsyncLocalStorage } from "node:async_hooks";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import type { JobContext } from "~/server/generic/jobs/types";

type WorkflowExecution = Readonly<{
  runId: string;
  attempt: number;
  database?: Database;
  /** The executing Job's fence, handed in by the handler that owns the claim. */
  job: Pick<JobContext, "fence" | "check">;
}>;
const execution = new AsyncLocalStorage<WorkflowExecution>();
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

/** Check current ownership before starting another provider batch; no connection spans inference. */
export async function assertWorkflowCurrent(): Promise<void> {
  await execution.getStore()?.job.check();
}

/** Effect ownership comes solely from the current Job token and generation. */
export async function assertWorkflowEffect(db: Database): Promise<void> {
  await execution.getStore()?.job.fence(db);
}

import { AsyncLocalStorage } from "node:async_hooks";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import {
  assertCurrentJob,
  currentJobExecution,
} from "~/server/generic/jobs/repo/execution";

type WorkflowExecution = Readonly<{
  runId: string;
  attempt: number;
  database?: Database;
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
  if (execution.getStore() && !currentJobExecution())
    throw new WorkflowInterruptedError("superseded");
  await assertCurrentJob();
}

/** Effect ownership comes solely from the current Job token and generation. */
export async function assertWorkflowEffect(db: Database): Promise<void> {
  if (execution.getStore() && !currentJobExecution())
    throw new WorkflowInterruptedError("superseded");
  await assertCurrentJob(db);
}

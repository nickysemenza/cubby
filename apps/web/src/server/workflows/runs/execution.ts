import { AsyncLocalStorage } from "node:async_hooks";

import { runEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";

type WorkflowExecution = Readonly<{
  runId: string;
  attempt: number;
  database?: Database;
}>;
const execution = new AsyncLocalStorage<WorkflowExecution>();
export const hasWorkflowExecution = () => execution.getStore() !== undefined;

export class WorkflowInterruptedError extends Error {
  constructor(readonly reason: "cancelled" | "superseded") {
    super(`Workflow execution interrupted: ${reason}`);
  }
}
export function workflowInterruption(
  error: UnparsedError,
): WorkflowInterruptedError | null {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof WorkflowInterruptedError) return error;
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

/** Read authority before admitting another provider batch; no connection spans inference. */
export async function assertWorkflowCurrent(): Promise<void> {
  const owner = execution.getStore();
  if (!owner) return;
  await assertWorkflowEffect(
    owner.database ?? (await import("~/server/db")).db,
  );
}

/** Must run inside the fresh transaction admitting an effect, never around a model call. */
export async function assertWorkflowEffect(db: Database): Promise<void> {
  const owner = execution.getStore();
  if (!owner) return;
  const [current] = await getDb(db)
    .select({
      status: run.status,
      attempt: sql<number>`coalesce((${run.progress}->>'attempt')::int, 0)`,
    })
    .from(run)
    .where(eq(run.id, runEntityId.parse(owner.runId)));
  if (!current || current.attempt !== owner.attempt)
    throw new WorkflowInterruptedError("superseded");
  if (current.status !== "running")
    throw new WorkflowInterruptedError("cancelled");
}

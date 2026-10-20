import { AsyncLocalStorage } from "node:async_hooks";

import { runEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { withTransactionDatabase } from "~/server/db/helpers";
import { appSettings, run } from "~/server/db/schema";

import {
  WORKFLOW_DEPLOYMENT_SETTINGS_ID,
  workflowDeploymentActivation,
  readWorkflowDeployment,
} from "./activation";

type WorkflowExecution = Readonly<{
  runId: string;
  attempt: number;
  version: string;
  epoch?: number;
  database?: Database;
}>;
const execution = new AsyncLocalStorage<WorkflowExecution>();
export const hasWorkflowExecution = () => execution.getStore() !== undefined;

export class WorkflowInterruptedError extends Error {
  constructor(
    readonly reason:
      | "cancelled"
      | "superseded"
      | "deployment"
      | "activation_pending",
  ) {
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

export async function withWorkflowDeploymentEffect<T>(
  db: Database,
  identity: { version: string; epoch: number },
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, async (tx) => {
    const active = await readWorkflowDeployment(tx);
    if (!active) throw new WorkflowInterruptedError("activation_pending");
    if (
      active.workerVersion !== identity.version ||
      active.epoch !== identity.epoch
    )
      throw new WorkflowInterruptedError("deployment");
    return work(tx);
  });
}

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
      activation: appSettings.metadata,
    })
    .from(run)
    .leftJoin(appSettings, eq(appSettings.id, WORKFLOW_DEPLOYMENT_SETTINGS_ID))
    .where(eq(run.id, runEntityId.parse(owner.runId)));
  if (!current || current.attempt !== owner.attempt)
    throw new WorkflowInterruptedError("superseded");
  if (current.status !== "running")
    throw new WorkflowInterruptedError("cancelled");
  if (!current.activation)
    throw new WorkflowInterruptedError("activation_pending");
  const activation = workflowDeploymentActivation.parse(current.activation);
  if (
    activation.workerVersion !== owner.version ||
    (owner.epoch !== undefined && activation.epoch !== owner.epoch)
  )
    throw new WorkflowInterruptedError("deployment");
}

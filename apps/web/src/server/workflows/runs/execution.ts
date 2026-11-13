import { AsyncLocalStorage } from "node:async_hooks";

import { jobState } from "@cubby/schemas/job";
import { sql, type SQL } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobSupersededError } from "~/server/generic/jobs/errors";

/** What an executing claim lends workflow code: a fence for open transactions and a pre-provider check. */
export type ExecutionClaim = Readonly<{
  /** Fence a transaction the caller opened (domain locks first); commits only while the claim owns its work. */
  fence(tx: Database): Promise<void>;
  /** Throws once the claim no longer owns its work, before paid or external work. */
  check(): Promise<void>;
}>;

type ExecutionFence = Readonly<{
  /** The executing claim's fence, handed in by the code that owns the claim. */
  job: ExecutionClaim;
}>;

/**
 * One Run's execution under its kernel Pass. Workflow code reads
 * the generation it runs under and fences its writes on `live`.
 */
export type RunExecution = Readonly<{
  runId: string;
  /** The execution generation `Run.progress.attempt` records. */
  generation: number;
  /** SQL that holds while this execution still owns its Run, for guarded writes. */
  live: SQL<boolean>;
  /** A Job that was reclaimed or restarted, so a reconciled failure may be its own. */
  recovered: boolean;
}>;

type WorkflowExecution = ExecutionFence &
  Readonly<{
    runId: string | null;
    attempt: number;
    database?: Database;
    /** Supplied by a Pass; a Job execution derives both from its claim. */
    live?: SQL<boolean>;
    recovered?: boolean;
  }>;
const execution = new AsyncLocalStorage<
  ExecutionFence & { run: RunExecution | null }
>();
export const hasWorkflowExecution = () =>
  execution.getStore() !== undefined || currentJobExecution() !== undefined;

/** The Run execution the current code runs under; null outside one. */
export const currentRunExecution = (): RunExecution | null =>
  execution.getStore()?.run ?? null;

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

/** A retained producer Job claim lends its authority to its requester Run. */
function jobExecution(): Pick<RunExecution, "live" | "recovered"> {
  const claim = currentJobExecution()?.claim;
  if (!claim) return { live: sql<boolean>`false`, recovered: false };
  return {
    live: sql<boolean>`EXISTS (SELECT 1 FROM "Job" j WHERE j.id=${claim.id}::uuid AND j.state=${jobState.enum.running} AND j."generation"=${claim.generation} AND j."leaseToken"=${claim.leaseToken}::uuid AND j."leaseExpiresAt">now())`,
    recovered: !(claim.generation === 1 && claim.attempts === 0),
  };
}

export const withWorkflowExecution = <T>(
  identity: WorkflowExecution,
  work: () => Promise<T>,
) => {
  const run: RunExecution | null = identity.runId
    ? {
        runId: identity.runId,
        generation: identity.attempt,
        ...(identity.live
          ? { live: identity.live, recovered: identity.recovered ?? false }
          : jobExecution()),
      }
    : null;
  return execution.run({ job: identity.job, run }, work);
};
/** A standalone claim that calls providers outside a Run scopes its own fence, so a lost claim stops the next paid request. */
export const withJobFence = <T>(
  job: ExecutionFence["job"],
  work: () => Promise<T>,
) => execution.run({ job, run: null }, work);

/** Check current ownership before starting another provider batch; no connection spans inference. */
export async function assertWorkflowCurrent(): Promise<void> {
  await execution.getStore()?.job.check();
}

/** Effect ownership comes solely from the current claim. */
export async function assertWorkflowEffect(db: Database): Promise<void> {
  await execution.getStore()?.job.fence(db);
}

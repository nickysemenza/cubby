import { AsyncLocalStorage } from "node:async_hooks";

import { type SQL } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { withWorkContext, inWorkContext } from "~/server/kernel/context";
import { WorkSupersededError } from "~/server/kernel/work-errors";

/** What an executing claim lends workflow code: a fence for open transactions and a pre-provider check. */
export type ExecutionClaim = Readonly<{
  /** Fence a transaction the caller opened (domain locks first); commits only while the claim owns its work. */
  fence(tx: Database): Promise<void>;
  /** Throws once the claim no longer owns its work, before paid or external work. */
  check(): Promise<void>;
}>;

type ExecutionFence = Readonly<{
  /** The executing claim's fence, handed in by the code that owns the claim. */
  claim: ExecutionClaim;
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
  /** A Pass that was reclaimed or restarted, so a reconciled failure may be its own. */
  recovered: boolean;
}>;

type WorkflowExecution = ExecutionFence &
  Readonly<{
    runId: string | null;
    attempt: number;
    database?: Database;
    /** The Pass supplies the live claim predicate. */
    live: SQL<boolean>;
    recovered?: boolean;
  }>;
const execution = new AsyncLocalStorage<
  ExecutionFence & { run: RunExecution | null }
>();
export const hasWorkflowExecution = () =>
  execution.getStore() !== undefined || inWorkContext();

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
): WorkflowInterruptedError | WorkSupersededError | null {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (
      error instanceof WorkflowInterruptedError ||
      error instanceof WorkSupersededError
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
) => {
  const run: RunExecution | null = identity.runId
    ? {
        runId: identity.runId,
        generation: identity.attempt,
        live: identity.live,
        recovered: identity.recovered ?? false,
      }
    : null;
  return withWorkContext(() =>
    execution.run({ claim: identity.claim, run }, work),
  );
};
/** A standalone claim that calls providers outside a Run scopes its own fence, so a lost claim stops the next paid request. */
export const withExecutionFence = <T>(
  claim: ExecutionFence["claim"],
  work: () => Promise<T>,
) => withWorkContext(() => execution.run({ claim, run: null }, work));

/** Check current ownership before starting another provider batch; no connection spans inference. */
export async function assertWorkflowCurrent(): Promise<void> {
  await execution.getStore()?.claim.check();
}

/** Effect ownership comes solely from the current claim. */
export async function assertWorkflowEffect(db: Database): Promise<void> {
  await execution.getStore()?.claim.fence(db);
}

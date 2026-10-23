import { AsyncLocalStorage } from "node:async_hooks";

import type { Database } from "~/server/db/database";

import type { JobClaim } from "./repo/jobs";

export type JobExecutionDetails = {
  stepKey: string | null;
  phase?: string | null;
  phaseStartedAt?: number;
  phaseMs?: Record<string, number>;
};
const execution = new AsyncLocalStorage<{
  db: Database;
  claim: JobClaim;
  details: JobExecutionDetails;
}>();

/** The selected domain step annotates page logs without changing execution state. */
export const setJobStepKey = (stepKey: string) => {
  const current = execution.getStore();
  if (current) current.details.stepKey = stepKey;
};

export const currentJobExecution = () => execution.getStore();
export const withJobExecution = <T>(
  db: Database,
  claim: JobClaim,
  work: () => Promise<T>,
  details: JobExecutionDetails = { stepKey: null },
) => execution.run({ db, claim, details }, work);

/** Aggregate phase timings contain no prompts or household evidence. */
export async function withJobPhase<T>(
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  const details = execution.getStore()?.details;
  if (!details) return work();
  const previous = {
    phase: details.phase,
    phaseStartedAt: details.phaseStartedAt,
  };
  const started = Date.now();
  details.phase = phase;
  details.phaseStartedAt = started;
  try {
    return await work();
  } finally {
    details.phaseMs ??= {};
    details.phaseMs[phase] =
      (details.phaseMs[phase] ?? 0) + Date.now() - started;
    Object.assign(details, previous);
  }
}

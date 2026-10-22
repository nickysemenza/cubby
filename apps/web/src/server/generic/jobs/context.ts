import { AsyncLocalStorage } from "node:async_hooks";

import type { Database } from "~/server/db/database";

import type { JobClaim } from "./repo/jobs";

export type JobExecutionDetails = { stepKey: string | null };
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

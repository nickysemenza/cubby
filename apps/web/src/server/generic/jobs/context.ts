import { AsyncLocalStorage } from "node:async_hooks";

import type { Database } from "~/server/db/database";

import type { JobClaim } from "./repo/jobs";

const execution = new AsyncLocalStorage<{ db: Database; claim: JobClaim }>();

export const currentJobExecution = () => execution.getStore();
export const withJobExecution = <T>(
  db: Database,
  claim: JobClaim,
  work: () => Promise<T>,
) => execution.run({ db, claim }, work);

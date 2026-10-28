import { AsyncLocalStorage } from "node:async_hooks";

import type { Database } from "~/server/db/database";

import type { JobClaim } from "./repo/queue";

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
const activePhases = new WeakMap<
  JobExecutionDetails,
  {
    previous: Pick<JobExecutionDetails, "phase" | "phaseStartedAt">;
    entries: Map<symbol, { phase: string; started: number }>;
  }
>();

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
  const phases = activePhases.get(details) ?? {
    previous: { phase: details.phase, phaseStartedAt: details.phaseStartedAt },
    entries: new Map<symbol, { phase: string; started: number }>(),
  };
  activePhases.set(details, phases);
  const token = Symbol(phase);
  const started = Date.now();
  const update = () => {
    const active = [...phases.entries.values()];
    if (active.length) {
      details.phase = [...new Set(active.map((entry) => entry.phase))].join(
        ", ",
      );
      details.phaseStartedAt = Math.min(
        ...active.map((entry) => entry.started),
      );
    } else {
      Object.assign(details, phases.previous);
      activePhases.delete(details);
    }
  };
  phases.entries.set(token, { phase, started });
  update();
  try {
    return await work();
  } finally {
    details.phaseMs ??= {};
    details.phaseMs[phase] =
      (details.phaseMs[phase] ?? 0) + Date.now() - started;
    // Parallel stages can finish out of order; restore only phases still active.
    phases.entries.delete(token);
    update();
  }
}

export const inJobExecution = () => !!execution.getStore();

import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  runStepDeclaration,
  type ExecutedRunPurpose,
  type RunInput,
  type RunStepKey,
  type StepRunPurpose,
} from "@cubby/schemas/run-fields";
import type { RunStepMeta } from "@cubby/schemas/run-step";
import { z } from "zod";

import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
import { assertCurrentJob } from "~/server/generic/jobs/repo/execution";
import type { JobClaim } from "~/server/generic/jobs/repo/jobs";
import type { JobHandler } from "~/server/generic/jobs/types";

import { ensureRun, systemActor } from "./ensure-run";
import {
  endSupersededRoutineRuns,
  ensureRunSteps,
  finishStepRunRow,
  readRunSteps,
  recordRunStepPage,
  startRunStep,
} from "./run-step";

/** Routine kinds whose own Job owns the pass and creates the Run lazily. */
export type RoutineStepPurpose = Exclude<StepRunPurpose, ExecutedRunPurpose>;

/** One page of a routine pass; `pending` counts the records it will change. */
type RoutinePage = {
  /** Keyset cursors are string-valued, so they persist as the Job cursor. */
  next: Record<string, string> | null;
  scanned: number;
  pending: number;
  /** Only database writes; returned tallies add to the step. */
  publish?: (tx: Database) => Promise<Record<string, number> | void>;
};

/**
 * A routine pass's step. Its own Job pages it; the Run appears only when a
 * page has pending writes, and `count` (the estimate, for an `estimate` step)
 * freezes the population then. A null page means the pass cannot run.
 */
type RoutineStepDriver = {
  count(db: Database): Promise<number>;
  page(
    db: Database,
    cursor: Record<string, string> | null,
  ): Promise<RoutinePage | null>;
};
export type RoutineStepDriversFor<P extends RoutineStepPurpose> = {
  [K in RunStepKey<P>]: RoutineStepDriver;
};

const routineCursor = z.object({
  runId: runEntityId.nullable().optional(),
  at: z.record(z.string(), z.string()).nullable().optional(),
});

/**
 * The Job owns a routine pass (refresh families). Its Run is created by the
 * first page with pending writes and rides in the Job cursor; an idle pass
 * leaves no Run. Invalidation restarts the pass, so a new Run ends the one the
 * abandoned generation opened.
 */
export function routineStepHandler<P extends RoutineStepPurpose>(
  purpose: P,
  pass: {
    key: (claim: JobClaim) => RunStepKey<P>;
    input: (key: RunStepKey<P>) => RunInput;
    drivers: RoutineStepDriversFor<P>;
  },
): JobHandler {
  return {
    prepare: async (db, claim) => {
      const key = pass.key(claim);
      const driver: RoutineStepDriver = pass.drivers[key];
      const cursor = routineCursor.parse(claim.cursor ?? {});
      const page = await driver.page(db, cursor.at ?? null);
      if (!page)
        return { page: { done: true, result: { outcome: "unavailable" } } };
      const runId =
        cursor.runId ??
        (page.pending > 0
          ? await openRoutineRun(db, claim, {
              purpose,
              key,
              input: pass.input(key),
              driver,
            })
          : null);
      const done = page.next === null;
      return {
        page: {
          done,
          ...(page.next && { cursor: { runId, at: page.next } }),
        },
        publish: async (tx) => {
          const tallies = (await page.publish?.(tx)) ?? {};
          if (runId)
            await recordRoutinePage(tx, runId, {
              purpose,
              key,
              scanned: page.scanned,
              tallies,
              done,
            });
          return done
            ? { outcome: runId ? "published" : "nothing", runId }
            : undefined;
        },
      };
    },
  };
}

async function openRoutineRun<P extends RoutineStepPurpose>(
  db: Database,
  claim: JobClaim,
  pass: {
    purpose: P;
    key: RunStepKey<P>;
    input: RunInput;
    driver: RoutineStepDriver;
  },
): Promise<RunId> {
  return withTransactionDatabase(db, async (tx) => {
    await assertCurrentJob(tx);
    const runId = await ensureRun(tx, systemActor(), {
      purpose: pass.purpose,
      trigger: "scheduled",
      status: "running",
      execution: false,
      clientKey: `${pass.purpose}:${pass.key}:${claim.id}:${claim.generation}`,
      input: pass.input,
    });
    await endSupersededRoutineRuns(tx, {
      purpose: pass.purpose,
      input: pass.input,
      keep: runId,
    });
    const declaration = runStepDeclaration(pass.purpose, pass.key);
    if (!declaration)
      throw new Error(`${pass.purpose} declares no ${pass.key} step`);
    await ensureRunSteps(tx, runId, [
      { key: pass.key, label: declaration.label },
    ]);
    const total = await pass.driver.count(tx);
    const { mode } = declaration.input;
    await startRunStep(tx, runId, pass.key, {
      found: mode === "count" ? total : 0,
      input: {
        mode,
        total: mode === "tally" ? null : total,
        boundary: null,
        countedAt: new Date().toISOString(),
      },
    });
    return runId;
  });
}

async function recordRoutinePage<P extends RoutineStepPurpose>(
  tx: Database,
  runId: RunId,
  page: {
    purpose: P;
    key: RunStepKey<P>;
    scanned: number;
    tallies: Record<string, number>;
    done: boolean;
  },
) {
  const step = (await readRunSteps(tx, runId)).find(
    (row) => row.key === page.key,
  );
  if (!step) throw new Error(`Routine Run ${runId} has no ${page.key} step`);
  const tallies = { ...step.meta?.tallies };
  for (const [name, value] of Object.entries(page.tallies))
    if (value) tallies[name] = (tallies[name] ?? 0) + value;
  const done = step.done + page.scanned;
  // Records deleted after the count froze end as `removed`, so a finished
  // count step accounts for its whole population.
  if (page.done && step.meta?.input?.mode === "count" && step.found > done)
    tallies.removed = (tallies.removed ?? 0) + step.found - done;
  const meta: RunStepMeta = {
    tallies,
    action: page.done
      ? null
      : (runStepDeclaration(page.purpose, page.key)?.action ?? null),
  };
  await recordRunStepPage(tx, runId, page.key, {
    delta: { done: page.scanned },
    meta,
    ...(page.done && { state: "done" as const }),
  });
  if (page.done)
    await finishStepRunRow(tx, runId, 1, { failedLabels: [], routine: false });
}

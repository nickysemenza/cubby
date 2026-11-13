/**
 * Run execution as a kernel Pass (ADR 0029 section 7): one `run.execute`
 * Pass per step-ledger or AI-work Run, keyed by the Run's id. The cursor
 * names the execution generation; the RunStep ledger and the Run row are the
 * checkpoint and `RunStep` keeps counts and reasons. A member's pause or
 * cancel cancels the Pass, and the Run's status fences every page through
 * `claimWorkflowRun`. Funding pauses, capacity waits and Sweep waits are Pass
 * waits with their cause; an AI-work Run waits for the evaluations or asks
 * that carry its id, which wake it as they settle.
 */
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryProgress } from "@cubby/schemas/mailbox-research";
import { RUN_KINDS } from "@cubby/schemas/run-fields";
import { and, eq, sql, type SQL } from "drizzle-orm";

import { findErrorCause } from "~/lib/error-diagnostics";
import { findFundingWait } from "~/server/ai/budget";
import { GatewayProviderStopError } from "~/server/ai/gateway-egress-client";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { run } from "~/server/db/retained-tables";
import { readRun } from "~/server/domains/run/repo/ai-work-state";
import { pendingFundingResumeAt } from "~/server/domains/run/repo/execution-context";
import {
  readRunPass,
  RUN_EXECUTE_PASS,
  runPassCursor,
  type PassRunPurpose,
  type RunPassCursor,
} from "~/server/domains/run/repo/run-execution";
import { listRunSteps } from "~/server/domains/run/repo/run-step";
import {
  JobDeferredError,
  JobSupersededError,
} from "~/server/generic/jobs/errors";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import {
  cancelWork,
  definePass,
  startPass,
  type Claim,
  type Pass,
} from "~/server/kernel/api";
import { fenceClaim } from "~/server/kernel/claim";

import { withWorkflowExecution } from "./execution";
import { resumeClaimedWorkflowRun } from "./lifecycle";

// TODO(kernel PassResult.waitCause): return typed waits instead of JobDeferredError.
type PassResult = Awaited<ReturnType<Pass["run"]>>;

/** Pass claims last 90 s; a page renews well inside that. */
const CLAIM_MS = 90_000;
const HEARTBEAT_MS = 30_000;
/**
 * An AI-work Run is woken when its evaluations or asks settle; this only
 * recovers a wake that never came.
 */
const AI_WORK_FALLBACK_MS = 15 * 60_000;

const fundingRelease = mailboxDiscoveryProgress.pick({
  fundingReleasedAt: true,
});

const passTarget = (runId: string) => ({
  table: "Pass" as const,
  name: RUN_EXECUTE_PASS,
  key: runId,
});

/** The claim as workflow code sees it: a fence for open transactions and a pre-provider check. */
// TODO(kernel Claim.fence): replace the internal fenceClaim import with claim.fence(tx).
const passFence = (claim: Claim, runId: string) => ({
  fence: (tx: Database) =>
    fenceClaim(repositoryQueries(tx), passTarget(runId), claim.token),
  async check() {
    if (!(await claim.renew())) throw new JobSupersededError();
  },
});

/** SQL true while this claim still holds the Run's Pass, for guarded Run writes. */
const passLive = (runId: string, token: string) =>
  sql<boolean>`EXISTS (SELECT 1 FROM "Pass" p WHERE p.name = ${RUN_EXECUTE_PASS}
    AND p.key = ${runId} AND p."claimToken" = ${token}::uuid
    AND p."claimDeadline" > now() AND p."cancelledAt" IS NULL)`;

/**
 * A step paused for member attention with no deadline (automatic AI turned
 * off) holds the Run paused with its reason until a member resumes it.
 */
async function holdForMember(
  claim: Claim,
  runId: RunId,
  reason: string | null,
) {
  await claim.fenced(async (tx) => {
    await getDb(tx)
      .update(run)
      .set({
        status: "paused",
        failureCode: null,
        ...(reason ? { dispatchError: reason } : {}),
      })
      .where(
        and(
          eq(run.id, runId),
          eq(run.status, "paused_auth"),
          eq(run.failureCode, "execution_limit"),
        ),
      );
  });
}

async function advance(
  db: Database,
  claim: Claim,
  cursor: RunPassCursor,
): Promise<PassResult> {
  const runId = runEntityId.parse(cursor.runId);
  const params = { runId, attempt: cursor.generation };
  const before = await readRun(db, runId);
  if (!before || before.purpose !== cursor.purpose)
    return { cursor, done: true };
  if (
    before.status === "paused_auth" &&
    before.failureCode === "execution_limit"
  ) {
    // Only the funding window's end or an explicit launch lifts a funding pause.
    const pending = await pendingFundingResumeAt(db);
    if (
      pending &&
      !fundingRelease.safeParse(before.progress).data?.fundingReleasedAt
    )
      throw new JobDeferredError(
        before.dispatchError ?? "Run awaits its funding window",
        pending,
        "ai_funding_window",
      );
    await resumeClaimedWorkflowRun(db, params, "funding_ready");
  }
  // SAFETY: the cursor was written by `startRunPass` for a Pass-executed kind.
  const purpose = cursor.purpose as PassRunPurpose;
  if (RUN_KINDS[purpose].execution === "steps") {
    const next = await (
      await import("~/server/domains/run/service/step-run")
    ).advanceStepRun(db, params);
    if (next.kind === "finished" || next.kind === "lost")
      return { cursor, done: true };
    if (next.kind === "paused") {
      const paused = (await listRunSteps(db, runId)).find(
        (step) => step.state === "paused",
      );
      if (paused?.pausedUntil)
        throw new JobDeferredError(
          paused.pausedReason ?? "Step capacity wait",
          paused.pausedUntil,
          next.waitReason ?? "provider_capacity",
        );
      await holdForMember(claim, runId, paused?.pausedReason ?? null);
      return { cursor, done: true };
    }
    const seconds = next.waitSeconds ?? 0;
    if (seconds > 0)
      throw new JobDeferredError(
        "Waiting for step capacity",
        new Date(Date.now() + seconds * 1000),
        "provider_capacity",
      );
    return { cursor, done: false };
  }
  const pending = await (
    await import("~/server/domains/run/service/ai-work")
  ).advanceAiWorkRun(db, params);
  return pending
    ? {
        cursor,
        done: false,
        availableAt: new Date(Date.now() + AI_WORK_FALLBACK_MS),
      }
    : { cursor, done: true };
}

/** A failure that spends this Pass's last attempt fails its Run promptly. */
async function reconcileIfLastAttempt(
  db: Database,
  runId: RunId,
  error: unknown,
) {
  const failure = classifyJobFailure(error);
  if (failure.kind !== "failed" && failure.kind !== "isolated") return;
  const pass = await readRunPass(db, runId);
  if (pass && pass.attempts + 1 >= pass.maxAttempts) {
    const { scheduleRunsReconcile } = await import("./reconcile-pass");
    await scheduleRunsReconcile(db, new Date(Date.now() + 5_000));
  }
}

// TODO(kernel claim-deadline wake): remove this per-pass recovery wake and its heartbeat wake.
async function recoveryWake(deadline: Date) {
  const { wakeAt } = await import("../background-tasks/publish");
  await wakeAt(new Date(deadline.getTime() + 5_000), {
    source: "run.execute.recovery",
  });
}

/** A funding or provider stop is a wait with its cause, never a spent attempt. */
async function asWait(
  claim: Claim,
  runId: RunId,
  error: unknown,
): Promise<JobDeferredError | null> {
  const funding = findFundingWait(error);
  const provider = findErrorCause(
    error,
    (cause): cause is GatewayProviderStopError =>
      cause instanceof GatewayProviderStopError,
  );
  const wait = funding ?? provider;
  if (!wait) return null;
  const deferred = new JobDeferredError(
    error instanceof Error ? error.message : wait.message,
    wait.until,
    wait.reason,
  );
  // A provider stop names itself on the Run; a budget stop already paused it.
  if (provider && wait === provider)
    await claim.fenced(async (tx) => {
      await getDb(tx)
        .update(run)
        .set({ dispatchError: deferred.message })
        .where(and(eq(run.id, runId), eq(run.status, "running")));
    });
  // Keep the typed provider cause and raw gateway diagnostic at this seam.
  deferred.cause = error;
  return deferred;
}

export const runExecutePass = definePass({
  name: RUN_EXECUTE_PASS,
  async run(db, raw, claim) {
    const cursor = runPassCursor.parse(raw);
    const runId = runEntityId.parse(cursor.runId);
    // A worker killed mid-page (a deploy, a crash) leaves its claim to lapse;
    // a wake at the deadline hands the page to the next worker promptly.
    const recover = () => recoveryWake(claim.deadline);
    await recover();
    const heartbeat = setInterval(() => {
      void claim
        .renew()
        .then((held) =>
          held ? recoveryWake(new Date(Date.now() + CLAIM_MS)) : undefined,
        )
        .catch(() => {
          // SILENT: a failed renewal surfaces at the page's next fence or check.
        });
    }, HEARTBEAT_MS);
    try {
      return await withWorkflowExecution(
        {
          runId,
          attempt: cursor.generation,
          database: db,
          job: passFence(claim, runId),
          live: passLive(runId, claim.token),
        },
        () => advance(db, claim, cursor),
      );
    } catch (error) {
      const wait = await asWait(claim, runId, error);
      if (wait) throw wait;
      await reconcileIfLastAttempt(db, runId, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  },
});

/**
 * Start or bring forward a Run's Pass. A live Pass keeps its cursor and
 * generation and becomes due now; a finished, cancelled or exhausted one
 * restarts at `generation`.
 */
export async function startRunPass(
  db: Database,
  input: {
    runId: RunId;
    purpose: PassRunPurpose;
    generation: number;
    restart: boolean;
  },
) {
  const target = passTarget(input.runId);
  // TODO(kernel Pass priority): carry member-started priority into startPass. Reference: launchPassRun.
  // An exhausted Pass is still pending to `startPass`; cancelling first makes it restart fresh.
  if (input.restart) await cancelWork(db, target);
  await startPass(db, runExecutePass, {
    key: input.runId,
    runId: input.runId,
    cursor: {
      runId: input.runId,
      purpose: input.purpose,
      generation: input.generation,
    },
  });
  if (input.restart) {
    // TODO(kernel startPass): restarted cancelled Passes must clear their prior claim token.
    await repositoryQueries(db).execute(sql`UPDATE "Pass" SET "claimToken" = NULL, "claimDeadline" = NULL,
      "waitCause" = NULL, "lastError" = NULL WHERE name = ${RUN_EXECUTE_PASS} AND key = ${input.runId}`);
  }
}

/** Stop a Run's Pass; a live page stops at its next renewal or fence. */
export const cancelRunPass = (db: Database, runId: string) =>
  cancelWork(db, passTarget(runId));

/**
 * Bring the pending Passes of these Runs (a SQL list of Run ids) forward:
 * an AI-work Run continues as soon as the work it waits on settles.
 */
export async function wakeRunPasses(db: Database, runIds: SQL) {
  const waiting = await repositoryQueries(db).execute<{
    key: string;
    cursor: unknown;
  }>(sql`SELECT p.key, p.cursor FROM "Pass" p
    WHERE p.name = ${RUN_EXECUTE_PASS} AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL
      AND p."availableAt" > now()
      AND p.key IN (SELECT ids."runId"::text FROM (${runIds}) ids("runId"))`);
  for (const row of waiting.rows) {
    const cursor = runPassCursor.safeParse(row.cursor).data;
    if (cursor)
      await startPass(db, runExecutePass, {
        key: row.key,
        runId: row.key,
        cursor,
      });
  }
}

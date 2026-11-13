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
import type { ExecutionWaitReason } from "@cubby/schemas/execution";
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  MAIL_DISCOVERY_ADMISSION_WAIT,
  mailboxDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
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
  sweepPassSourceHeld,
  RUN_EXECUTE_PASS,
  runPassCursor,
  type PassRunPurpose,
  type RunPassCursor,
} from "~/server/domains/run/repo/run-execution";
import { listRunSteps } from "~/server/domains/run/repo/run-step";
import {
  cancelWork,
  definePass,
  startPass,
  type Claim,
  type PassResult,
} from "~/server/kernel/api";
import { classifyWorkFailure } from "~/server/kernel/failure";
import { WorkSupersededError } from "~/server/kernel/work-errors";

import { withWorkflowExecution } from "./execution";
import {
  mailDiscoveryBackpressure,
  yieldClaimedMailDiscovery,
  resumeClaimedWorkflowRun,
} from "./lifecycle";

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
const passFence = (claim: Claim) => ({
  fence: (tx: Database) => claim.fence(tx),
  async check() {
    if (!(await claim.renew())) throw new WorkSupersededError();
  },
});

const waitResult = (
  cursor: RunPassCursor,
  until: Date,
  reason: ExecutionWaitReason,
): PassResult => ({
  cursor,
  done: false,
  availableAt: until,
  waitCause: reason === "ai_funding_window" ? "funding" : reason,
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
  if (cursor.purpose === "mail_discovery") {
    if (before.status === "running")
      await yieldClaimedMailDiscovery(db, params);
    if (
      before.status === "paused" &&
      before.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT
    )
      await resumeClaimedWorkflowRun(db, params, "mail_admission");
    if (before.status === "failed" && before.failureCode === "job_failed")
      await resumeClaimedWorkflowRun(db, params);
  }
  if (
    before.status === "paused_auth" &&
    before.failureCode === "execution_limit"
  ) {
    // Only the funding window's end or a funding release lifts this pause.
    const pending = await pendingFundingResumeAt(db, runId);
    if (
      pending &&
      !fundingRelease.safeParse(before.progress).data?.fundingReleasedAt
    )
      return waitResult(cursor, pending, "ai_funding_window");
    await resumeClaimedWorkflowRun(db, params, "funding_ready");
  }
  if (cursor.purpose === "mail_discovery") {
    const page = await (
      await import("~/server/domains/purchase-import/operations/gmail/discovery")
    ).advanceMailDiscoveryPage(db, params, cursor.page ?? null);
    return {
      cursor: { ...cursor, ...(page.cursor ? { page: page.cursor } : {}) },
      done: page.done,
    };
  }
  // SAFETY: the cursor was written by `startRunPass` for a Pass-executed kind.
  const purpose = cursor.purpose as PassRunPurpose;
  if (purpose === "sweep" && (await sweepPassSourceHeld(db, runId)))
    return waitResult(
      cursor,
      new Date(Date.now() + 1_000 + Math.random() * 2_000),
      "provider_capacity",
    );
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
        return waitResult(
          cursor,
          paused.pausedUntil,
          next.waitReason ?? "provider_capacity",
        );
      await holdForMember(claim, runId, paused?.pausedReason ?? null);
      return { cursor, done: true };
    }
    const seconds = next.waitSeconds ?? 0;
    if (seconds > 0)
      return waitResult(
        cursor,
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
        waitCause: "in_flight",
      }
    : { cursor, done: true };
}

/** A failure that spends this Pass's last attempt fails its Run promptly. */
async function reconcileIfLastAttempt(
  db: Database,
  runId: RunId,
  error: unknown,
) {
  const failure = classifyWorkFailure(error);
  if (failure.kind !== "failed" && failure.kind !== "isolated") return;
  const pass = await readRunPass(db, runId);
  if (pass && pass.attempts + 1 >= pass.maxAttempts) {
    const { scheduleRunsReconcile } = await import("./reconcile-pass");
    await scheduleRunsReconcile(db, new Date(Date.now() + 5_000));
  }
}

/** A funding or provider stop is a wait with its cause, never a spent attempt. */
async function asWait(
  claim: Claim,
  runId: RunId,
  error: unknown,
  cursor: RunPassCursor,
): Promise<PassResult | null> {
  const funding = findFundingWait(error);
  const provider = findErrorCause(
    error,
    (cause): cause is GatewayProviderStopError =>
      cause instanceof GatewayProviderStopError,
  );
  const wait = funding ?? provider;
  if (!wait) return null;
  // A provider stop names itself on the Run; a budget stop already paused it.
  if (provider && wait === provider)
    await claim.fenced(async (tx) => {
      await getDb(tx)
        .update(run)
        .set({
          dispatchError: error instanceof Error ? error.message : wait.message,
        })
        .where(and(eq(run.id, runId), eq(run.status, "running")));
    });
  return waitResult(cursor, wait.until, wait.reason);
}

export const runExecutePass = definePass({
  name: RUN_EXECUTE_PASS,
  async run(db, raw, claim) {
    const cursor = runPassCursor.parse(raw);
    const runId = runEntityId.parse(cursor.runId);
    const heartbeat = setInterval(() => {
      void claim.renew().catch(() => {
        // SILENT: the next fence or pre-provider check reports lost ownership.
      });
    }, HEARTBEAT_MS);
    const started = performance.now();
    try {
      const result = await withWorkflowExecution(
        {
          runId,
          attempt: cursor.generation,
          database: db,
          recovered: true,
          claim: passFence(claim),
          live: passLive(runId, claim.token),
        },
        () => advance(db, claim, cursor),
      );
      if (!result.waitCause && !result.availableAt) {
        const sample = {
          ms: Math.max(1, performance.now() - started),
          at: new Date().toISOString(),
        };
        await claim.fenced(async (tx) => {
          await repositoryQueries(tx)
            .execute(sql`UPDATE "Pass" SET "durationHistory" = (
            SELECT coalesce(jsonb_agg(sample ORDER BY ordinal), '[]'::jsonb)
            FROM jsonb_array_elements("durationHistory" || ${JSON.stringify([sample])}::jsonb)
              WITH ORDINALITY recent(sample, ordinal)
            WHERE ordinal > jsonb_array_length("durationHistory") - 11
          ) WHERE name = ${RUN_EXECUTE_PASS} AND key = ${runId}`);
        });
      }
      return result;
    } catch (error) {
      const wait = await asWait(claim, runId, error, cursor);
      if (wait) return wait;
      const failure = classifyWorkFailure(
        mailDiscoveryBackpressure(error) ?? error,
      );
      if (failure.kind === "paused") return { cursor, done: true };
      if (failure.kind === "deferred")
        return waitResult(cursor, failure.until, failure.reason);
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

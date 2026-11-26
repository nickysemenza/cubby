/**
 * Passes (ADR 0029 section 7): one row per registered pass instance with a
 * resumable cursor under the shared claim. A pass page publishes only while
 * its claim is live; a cancelled or lapsed claim writes nothing.
 */
import { kernelWaitCause } from "@cubby/schemas/kernel/machinery";
import { createLogger } from "@cubby/worker-tracing";
import { sql, type SQL } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { withDatabaseRequestMetrics } from "~/server/db/db-observability";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { reportServerError } from "~/server/errors/report-error";
import { classifyWorkFailure, stopsPage } from "~/server/kernel/failure";
import { withTrace } from "~/server/observability/tracing";

import {
  ClaimLapsedError,
  rawError,
  claimPass,
  fenceClaim,
  renewClaim,
  settleFailure,
  type ClaimedPass,
  type ClaimTarget,
} from "./claim";
import type { Claim, Json, Pass } from "./define";
import { enterHouseholdGate } from "./gate";
import type { KernelRegistry } from "./registry";
import { isoText } from "./sql-time";
import { wakeAfterCommit, wakeAtDeadline } from "./wake";

const log = createLogger("kernel.pass");

const censusFloor = (cursor: SQL, ms: number) =>
  sql`(${cursor}->>'censusStartedAt')::timestamp + make_interval(secs => ${ms / 1000})`;

/**
 * Start (or restart a finished) pass instance; a pending one keeps its cursor.
 * `revive` is a scheduled start: a pending instance that spent its attempts
 * gets a fresh attempt budget and keeps its cursor and last error.
 * Returns whether the instance has attempts left, including a live claim or wait.
 */
export async function startPass(
  db: Database,
  pass: Pass,
  options: {
    key?: string;
    cursor?: Json | null;
    runId?: string | null;
    availableAt?: Date;
    revive?: boolean;
  } = {},
): Promise<boolean> {
  // Database time, not the Worker's clock: a skewed clock must not park the pass.
  const at = options.availableAt
    ? sql`${options.availableAt.toISOString()}::timestamp`
    : sql`now()`;
  const finished = sql`"Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL`;
  const reviving = sql`${options.revive ?? false} AND "Pass".attempts >= "Pass"."maxAttempts"`;
  const coalesceActive = pass.activeStart === "restart";
  // A queued scan already covers new requests. Flag a rerun once it has started.
  const recordRestart = sql`("Pass".attempts < "Pass"."maxAttempts" OR ${reviving})
    AND ("Pass"."claimToken" IS NOT NULL OR "Pass".cursor ? 'restartCursor'
      ${pass.restartFloorMs ? sql`OR "Pass".cursor ? 'censusStartedAt'` : sql``})`;
  const freshAt = pass.restartFloorMs
    ? sql`greatest(excluded."availableAt", CASE WHEN "Pass"."doneAt" IS NOT NULL
        THEN ${censusFloor(sql`"Pass".cursor`, pass.restartFloorMs)} END)`
    : sql`excluded."availableAt"`;
  const started = await repositoryQueries(db).execute<{
    at: string;
    due: boolean;
    live: boolean;
    claimable: boolean;
  }>(sql`
    INSERT INTO "Pass" (name, key, cursor, "runId", "availableAt")
    VALUES (${pass.name}, ${options.key ?? "default"}, ${JSON.stringify(options.cursor ?? null)}::jsonb,
      ${options.runId ?? null}::uuid, ${at})
    ON CONFLICT (name, key) DO UPDATE SET
      cursor = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN CASE WHEN "Pass".cursor ? ${"legacyJobs"} THEN
          coalesce(nullif(excluded.cursor, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(${"legacyJobs"}::text, "Pass".cursor->${"legacyJobs"})
          ELSE excluded.cursor END
        ELSE ${
          pass.activeStart === "restart"
            ? sql`CASE WHEN ${recordRestart}
            THEN coalesce(nullif("Pass".cursor, 'null'::jsonb), '{}'::jsonb)
              || jsonb_build_object(${"restartCursor"}::text, excluded.cursor)
            ELSE "Pass".cursor END`
            : sql`"Pass".cursor`
        } END,
      attempts = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
          OR (${options.revive ?? false} AND "Pass".attempts >= "Pass"."maxAttempts")
        THEN 0 ELSE "Pass".attempts END,
      "claimToken" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."claimToken" END,
      "claimDeadline" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."claimDeadline" END,
      "waitCause" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."waitCause" END,
      "lastError" = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL
        THEN NULL ELSE "Pass"."lastError" END,
      "runId" = coalesce(excluded."runId", "Pass"."runId"),
      "doneAt" = NULL, "cancelledAt" = NULL,
      "availableAt" = CASE WHEN ${coalesceActive} AND (${finished}) THEN ${freshAt} WHEN (${coalesceActive} AND NOT (${reviving})) OR "Pass"."waitCause" = ${kernelWaitCause.enum.funding} THEN "Pass"."availableAt" ELSE least("Pass"."availableAt", excluded."availableAt") END,
      "wakeVersion" = CASE WHEN NOT (${finished}) AND (${coalesceActive} OR "Pass"."waitCause" = ${kernelWaitCause.enum.funding}) THEN "Pass"."wakeVersion" ELSE "Pass"."wakeVersion" + 1 END, "updatedAt" = now()
    RETURNING ${isoText(sql`"availableAt"`)} AS at, "availableAt" <= now() AS due,
      attempts < "maxAttempts" AS live,
      attempts < "maxAttempts" AND (NOT ${coalesceActive} OR "claimToken" IS NULL
        OR "claimDeadline" <= now()) AS claimable`);
  const row = started.rows[0];
  // A pending Pass that spent its attempts keeps them until a member retries
  // it or a scheduled start revives it, so no runner can claim it and no wake
  // is owed. One revival per scheduled start bounds a Pass that always fails.
  if (!row?.claimable) return row?.live ?? false;
  // A future start owns its deadline; an immediate wake would find nothing due.
  if (!row.due) await wakeAtDeadline(db, new Date(row.at), "kernel.pass-start");
  else await wakeAfterCommit(db);
  return true;
}

// Leave room for one 22 s database transaction and fenced settlement.
const passPageHasTime = (claim: Pick<Claim, "deadline">) =>
  claim.deadline.getTime() - Date.now() > 30_000;

export class PassPageBudgetError extends Error {}

export function checkPassPageTime(claim?: Pick<Claim, "deadline">): void {
  if (!claim) return;
  if (claim.deadline.getTime() <= Date.now()) throw new ClaimLapsedError();
  if (!passPageHasTime(claim))
    throw new PassPageBudgetError("Pass page reached its transaction deadline");
}

/** Keep claim loss and retryable contention out of the per-item error path. */
export function rethrowPassPageControl(error: UnparsedError): void {
  const failure = classifyWorkFailure(error);
  if (
    error instanceof PassPageBudgetError ||
    stopsPage(failure) ||
    failure.kind === "transient"
  )
    throw error;
}

export type PassPageTransaction = <T>(
  work: (tx: Database) => Promise<T>,
) => Promise<T>;

/** Cap statements. Supply a transaction cap only before another owner arms the timer. */
export async function limitPassPageTransaction(
  tx: Database,
  statementMs: number,
  transactionMs?: number,
): Promise<void> {
  await repositoryQueries(tx).execute(sql`
    SELECT
      set_config('statement_timeout', lim.statement::text, true),
      set_config('lock_timeout', least(lim.lock, greatest(1, lim.statement / 2))::text, true)
      ${
        transactionMs === undefined
          ? sql``
          : sql`, set_config('transaction_timeout',
        least((SELECT nullif(setting::int, 0) FROM pg_settings WHERE name = 'transaction_timeout'), ${transactionMs})::text, true)`
      }
    FROM (SELECT
      least((SELECT nullif(setting::int, 0) FROM pg_settings WHERE name = 'statement_timeout'), ${statementMs}) AS statement,
      least((SELECT nullif(setting::int, 0) FROM pg_settings WHERE name = 'lock_timeout'), 500) AS lock
    ) lim`);
}

/** Bound DB-only work, including the gap between a Worker dying and its lease lapsing. */
export function withPassPageTransaction<T>(
  db: Database,
  work: (tx: Database) => Promise<T>,
  claim?: Pick<Claim, "deadline">,
  statementMs = 20_000,
  transactionMs = 22_000,
): Promise<T> {
  checkPassPageTime(claim);
  return repositoryTransactionDatabase(db, async (tx) => {
    checkPassPageTime(claim);
    await limitPassPageTransaction(tx, statementMs, transactionMs);
    return work(tx);
  });
}

/**
 * Fenced output publication takes the gate before the Pass row and any work.
 * A page that only settles its Pass row fences the claim without the gate.
 */
export function fencedPublication<T>(
  db: Database,
  target: Extract<ClaimTarget, { table: "Pass" }>,
  token: string,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return repositoryTransactionDatabase(db, async (tx) => {
    await enterHouseholdGate(tx);
    await fenceClaim(repositoryQueries(tx), target, token);
    return work(tx);
  });
}

function passClaim(db: Database, claimed: ClaimedPass): Claim {
  const target = {
    table: "Pass" as const,
    name: claimed.name,
    key: claimed.key,
  };
  const controller = new AbortController();
  return {
    token: claimed.token,
    deadline: claimed.deadline,
    signal: controller.signal,
    async renew() {
      const held = await renewClaim(
        repositoryQueries(db),
        target,
        claimed.token,
      );
      if (!held) controller.abort();
      return held;
    },
    fence: (tx) => fenceClaim(repositoryQueries(tx), target, claimed.token),
    fenced: (work) => fencedPublication(db, target, claimed.token, work),
  };
}

/** Claim and run one due pass page; false when none was due. */
export async function runOnePass(
  db: Database,
  registry: KernelRegistry,
): Promise<boolean> {
  return withTrace("kernel.pass.page", (span) =>
    withDatabaseRequestMetrics(span, async () => {
      const claimed = await claimPass(db, [...registry.passes.values()]);
      span.setAttribute("kernel.pass.claimed", claimed !== null);
      if (!claimed) return false;
      span.setAttribute("kernel.pass.name", claimed.name);
      const pass = registry.passes.get(claimed.name)!;
      const target = {
        table: "Pass" as const,
        name: claimed.name,
        key: claimed.key,
      };
      const claim = passClaim(db, claimed);
      let wait: { at: string; wait: boolean } | undefined;
      try {
        // SAFETY: the cursor column holds the JSON the pass last returned.
        const result = await pass.run(db, claimed.cursor as Json | null, claim);
        span.setAttribute("kernel.pass.result_done", result.done);
        const itemError = result.itemError ? rawError(result.itemError) : null;
        const restartPending =
          pass.activeStart === "restart"
            ? sql`coalesce(cursor ? ${"restartCursor"}, false)`
            : sql`false`;
        const restart = sql`${result.done} AND (${restartPending})`;
        const floor = pass.restartFloorMs;
        const restartAt = floor
          ? sql`greatest(now(), ${censusFloor(sql`cursor`, floor)})`
          : sql`now()`;
        const resultCursor = sql`${JSON.stringify(result.cursor)}::jsonb`;
        const nextCursor = floor
          ? sql`coalesce(nullif(${resultCursor}, 'null'::jsonb), '{}'::jsonb)
              || jsonb_build_object('censusStartedAt', cursor->'censusStartedAt')`
          : resultCursor;
        const checkpoint =
          pass.activeStart === "restart"
            ? sql`CASE
              WHEN ${restart} THEN cursor->${"restartCursor"}
              WHEN ${restartPending} THEN
                coalesce(nullif(${nextCursor}, 'null'::jsonb), '{}'::jsonb)
                || jsonb_build_object(${"restartCursor"}::text, cursor->${"restartCursor"})
              ELSE ${nextCursor} END`
            : nextCursor;
        const settle = (tx: Database) =>
          repositoryQueries(tx).execute<{
            at: string;
            wait: boolean;
          }>(sql`
        UPDATE "Pass" SET cursor = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} THEN
            CASE WHEN cursor ? ${"legacyJobs"} THEN
              coalesce(nullif(${checkpoint}, 'null'::jsonb), '{}'::jsonb) || jsonb_build_object(${"legacyJobs"}::text, cursor->${"legacyJobs"})
              ELSE ${checkpoint} END
            ELSE cursor END,
          "doneAt" = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} AND ${result.done} AND NOT (${restartPending}) THEN now() ELSE NULL END,
          "availableAt" = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} THEN CASE WHEN ${restart} THEN ${restartAt} ELSE ${result.availableAt ? sql`${result.availableAt.toISOString()}::timestamp` : sql`now()`} END ELSE CASE WHEN "waitCause" = ${kernelWaitCause.enum.funding} THEN "availableAt" ELSE least("availableAt", now()) END END,
          attempts = 0, "claimToken" = NULL, "claimDeadline" = NULL,
          "waitCause" = CASE WHEN "wakeVersion" = ${claimed.wakeVersion} THEN ${result.done ? null : (result.waitCause ?? null)} ELSE CASE WHEN "waitCause" = ${kernelWaitCause.enum.funding} THEN "waitCause" END END, "lastError" = ${itemError}, "updatedAt" = now()
          ${
            result.durationSample
              ? sql`, "durationHistory" = (
            SELECT jsonb_agg(sample ORDER BY ordinal)
            FROM jsonb_array_elements("durationHistory" || ${JSON.stringify([result.durationSample])}::jsonb)
              WITH ORDINALITY recent(sample, ordinal)
            WHERE ordinal > jsonb_array_length("durationHistory") - 11
          )`
              : sql``
          }
        WHERE name = ${claimed.name} AND key = ${claimed.key}
        RETURNING ${isoText(sql`"availableAt"`)} AS at, "doneAt" IS NULL AND "availableAt" > now() AS wait`);
        const published = result.publish
          ? await claim.fenced(async (tx) => {
              await result.publish?.(tx);
              return settle(tx);
            })
          : await repositoryTransactionDatabase(db, async (tx) => {
              await claim.fence(tx);
              return settle(tx);
            });
        wait = published.rows[0];
        if (itemError) {
          span.setError("Pass page skipped items");
          reportServerError(result.itemError, {
            operation: claimed.name,
            stage: "page-items",
          });
          log.warn("Pass page skipped items", {
            pass: claimed.name,
            error: itemError,
          });
        }
      } catch (error) {
        span.setError("Pass page failed");
        await settleFailure(
          repositoryQueries(db),
          target,
          claimed.token,
          claimed.attempts,
          error,
          claimed.wakeVersion,
        );
      }
      // The page's wait is a deadline it set; a delivery's own offer also covers it.
      if (wait?.wait)
        await wakeAtDeadline(db, new Date(wait.at), "kernel.pass-wait");
      return true;
    }),
  );
}

/**
 * The one claim module for the kernel's three work forms (ADR 0029 section
 * 7): a dirty scope, an Ask, a Pass. A claim is a token with a deadline; it
 * renews, counts attempts, backs off through `availableAt`, waits with a
 * cause, honours cancellation, and is classified by the single failure
 * classifier. A claim past its deadline cannot publish: every publishing
 * write checks the token and a live deadline under a row lock.
 */
import type { ExecutionWaitReason } from "@cubby/schemas/execution";
import {
  kernelLane,
  type KernelWaitCause,
} from "@cubby/schemas/kernel/machinery";
import {
  kernelWaitCause,
  MACHINERY_RAW_ERROR_BYTES,
} from "@cubby/schemas/kernel/machinery";
import { kernelStage } from "@cubby/schemas/kernel/stage";
import { sql, type SQL } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { textArrayParam } from "~/server/db/helpers/array-param";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";
import { classifyWorkFailure, type WorkFailure } from "~/server/kernel/failure";
import {
  backoffInterval,
  backoffMs,
  passFreeAt,
  passRecoveryAt,
} from "~/server/kernel/pass-timing";
import { WorkSupersededError } from "~/server/kernel/work-errors";

import type { AskKind, ClaimLimit, Pass, Reconciler } from "./define";
import type { KernelRegistry } from "./registry";
import { fromIso, isoText } from "./sql-time";
import { ASK, MEMBER_PASS } from "./vocab";
import { wakeClaimRecovery } from "./wake";

type Q = Pick<RepositoryQueryClient, "execute">;

export const CLAIM_LEASE_MS = 90_000;

/** Renew a complete compute batch in one statement; an expired token is never revived. */
export async function renewScopeClaims(
  q: Pick<RepositoryQueryClient, "execute">,
  scopes: readonly ClaimedScope[],
): Promise<void> {
  if (!scopes.length) return;
  await q.execute(sql`
    UPDATE "ScopeDirty" d SET "claimDeadline" = now() + ${leaseInterval(CLAIM_LEASE_MS)}
    FROM jsonb_to_recordset(${JSON.stringify(scopes.map(({ kind, key, token }) => ({ kind, key, token })))}::jsonb)
      AS r(kind text, key text, token uuid)
    WHERE d."scopeKind" = r.kind AND d."scopeKey" = r.key AND d."claimToken" = r.token
      AND d."claimDeadline" > now()`);
}
/** The `lastError` prefix of a dirty scope no reconciler in its Worker could run. */
export const UNREGISTERED_RECONCILER = "Unregistered reconciler: ";
/** Non-transient failures before a dirty scope is Stuck. */
export const MAX_SCOPE_ATTEMPTS = 5;
/** A fresh Pass tolerates 7.5 minutes of transient retries before spending an attempt. */
const PASS_TRANSIENT_FAILURES_PER_ATTEMPT = 5;
const UNREGISTERED_CHECK_MS = 10 * 60_000;
const lastUnregisteredCheck = new WeakMap<KernelRegistry, number>();
/** Consecutive `seq`/`rev` conflicts before a scope runs locked. */
export const LOCKED_RUN_AFTER_CONFLICTS = 3;

/** A claim lapsed or was cancelled; its holder must not publish. */
export class ClaimLapsedError extends WorkSupersededError {
  override name = "ClaimLapsedError";
}

export type ClaimTarget =
  | { table: "ScopeDirty"; kind: string; key: string }
  | { table: "Ask"; id: string }
  | { table: "Pass"; name: string; key: string };

const identity = (target: ClaimTarget): SQL => {
  switch (target.table) {
    case "ScopeDirty":
      return sql`"scopeKind" = ${target.kind} AND "scopeKey" = ${target.key}`;
    case "Ask":
      return sql`id = ${target.id}::uuid`;
    case "Pass":
      return sql`name = ${target.name} AND key = ${target.key}`;
  }
};
const tableOf = (target: ClaimTarget) => sql.raw(`"${target.table}"`);
const cancellable = (target: ClaimTarget) => target.table !== "ScopeDirty";
const leaseInterval = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

const WAIT_CAUSE = {
  provider_capacity: "provider_capacity",
  ai_funding_window: "funding",
  device: "device",
  rate_limit: "rate_limit",
} satisfies Record<ExecutionWaitReason, KernelWaitCause>;

/** Store driver causes before large wrappers can consume the 16 KB raw-error cap. */
export function rawError(error: UnparsedError): string {
  const details = describeErrorCauses(error);
  const text = JSON.stringify({
    ...details,
    causes: [...details.causes].reverse(),
  });
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= MACHINERY_RAW_ERROR_BYTES
    ? text
    : new TextDecoder().decode(bytes.slice(0, MACHINERY_RAW_ERROR_BYTES));
}

/** Extend a live claim; false once it lapsed, moved or was cancelled. */
export async function renewClaim(
  q: Q,
  target: ClaimTarget,
  token: string,
  leaseMs = CLAIM_LEASE_MS,
): Promise<boolean> {
  const result = await q.execute<{ deadline: string }>(sql`
    UPDATE ${tableOf(target)} SET "claimDeadline" = now() + ${leaseInterval(leaseMs)}
    WHERE ${identity(target)} AND "claimToken" = ${token}::uuid
      AND "claimDeadline" > now()
      ${cancellable(target) ? sql`AND "cancelledAt" IS NULL` : sql``}
    RETURNING ${isoText(sql`"claimDeadline"`)} AS deadline`);
  const row = result.rows[0];
  return !!row;
}

/**
 * Lock the claimed row and refuse a lapsed, moved or cancelled claim. Call it
 * inside the publishing transaction before any write.
 */
export async function fenceClaim(
  q: Q,
  target: ClaimTarget,
  token: string,
): Promise<void> {
  const result = await q.execute<{ live: boolean }>(sql`
    SELECT ("claimToken" = ${token}::uuid AND "claimDeadline" > now()
      ${cancellable(target) ? sql`AND "cancelledAt" IS NULL` : sql``}) AS live
    FROM ${tableOf(target)} WHERE ${identity(target)} FOR UPDATE`);
  if (!result.rows[0]?.live) throw new ClaimLapsedError();
}

export async function releaseClaim(
  q: Q,
  target: ClaimTarget,
  token: string,
): Promise<void> {
  await q.execute(sql`
    UPDATE ${tableOf(target)} SET "claimToken" = NULL, "claimDeadline" = NULL
    WHERE ${identity(target)} AND "claimToken" = ${token}::uuid`);
}

/** Request cancellation; a live holder sees it on its next renewal or fence. */
export async function cancelClaimable(
  q: Q,
  target: Extract<ClaimTarget, { table: "Ask" | "Pass" }>,
): Promise<void> {
  await q.execute(sql`
    UPDATE ${tableOf(target)} SET "cancelledAt" = coalesce("cancelledAt", now())
    WHERE ${identity(target)}`);
}

/**
 * Settle a failed claim through the single classifier. Waits spend no
 * attempt and lost claims settle nothing. Transient Pass failures spend one
 * attempt per group of consecutive failures. Other transient claims back off
 * without spending an attempt. Pass admission charges an expired token under
 * the row lock even when the old holder never reached settlement.
 */
export async function settleFailure(
  q: Q,
  target: ClaimTarget,
  token: string,
  attempts: number,
  error: UnparsedError,
  wakeVersion?: number,
): Promise<WorkFailure> {
  const failure = classifyWorkFailure(error);
  const raw = rawError(error);
  const owned = sql`${identity(target)} AND "claimToken" = ${token}::uuid
    ${target.table === "Pass" ? sql`AND "claimDeadline" > now() AND "cancelledAt" IS NULL` : sql``}`;
  switch (failure.kind) {
    case "interrupted":
      return failure;
    case "paused":
    case "deferred": {
      const until =
        failure.kind === "deferred"
          ? failure.until
          : new Date(Date.now() + backoffMs(1));
      const cause =
        failure.kind === "deferred"
          ? WAIT_CAUSE[failure.reason]
          : "provider_capacity";
      const released =
        cause === "funding" &&
        wakeVersion !== undefined &&
        target.table !== "ScopeDirty"
          ? sql`"wakeVersion" <> ${wakeVersion}`
          : sql`false`;
      await q.execute(sql`
        UPDATE ${tableOf(target)} SET "claimToken" = NULL, "claimDeadline" = NULL,
          "availableAt" = CASE WHEN ${released} THEN now() ELSE ${until.toISOString()}::timestamp END,
          "waitCause" = CASE WHEN ${released} THEN NULL ELSE ${cause} END,
          "lastError" = ${raw}
        WHERE ${owned}`);
      return failure;
    }
    case "transient": {
      if (target.table === "Pass") {
        const streak = sql`("transientFailures" + 1)`;
        // Attempts already charged by this streak must not add a second backoff step.
        const priorCharges = sql`"transientFailures" / ${PASS_TRANSIENT_FAILURES_PER_ATTEMPT}::int`;
        await q.execute(sql`
          UPDATE "Pass" SET "claimToken" = NULL, "claimDeadline" = NULL,
            "transientFailures" = ${streak},
            attempts = attempts + (${streak} % ${PASS_TRANSIENT_FAILURES_PER_ATTEMPT} = 0)::int,
            "availableAt" = now() + ${backoffInterval(sql`attempts - ${priorCharges} + ${streak}`)},
            "waitCause" = NULL, "lastError" = ${raw}
          WHERE ${owned}`);
        return failure;
      }
      await q.execute(sql`
        UPDATE ${tableOf(target)} SET "claimToken" = NULL, "claimDeadline" = NULL,
          "availableAt" = now() + ${leaseInterval(backoffMs(attempts + 1))},
          "waitCause" = NULL, "lastError" = ${raw}
        WHERE ${owned}`);
      return failure;
    }
    case "isolated":
    case "failed":
      await q.execute(sql`
        UPDATE ${tableOf(target)} SET "claimToken" = NULL, "claimDeadline" = NULL,
          attempts = attempts + 1,
          ${target.table === "Pass" ? sql`"transientFailures" = 0,` : sql``}
          "availableAt" = now() + ${leaseInterval(backoffMs(attempts + 1))},
          "waitCause" = NULL, "lastError" = ${raw}
        WHERE ${owned}`);
      return failure;
  }
}

/** Release a transient batch and record its error only for claims we still own. */
export async function settleTransientScopes(
  q: Q,
  scopes: readonly ClaimedScope[],
  version: number,
  rules: string,
  error: string,
): Promise<void> {
  const packed = scopes.map(({ kind, key, token, attempts }) => ({
    kind,
    key,
    token,
    delay: backoffMs(attempts + 1) / 1000,
  }));
  await q.execute(sql`
    WITH wanted AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(packed)}::jsonb)
        AS claim(kind text, key text, token uuid, delay double precision)
    ), owned AS MATERIALIZED (
      SELECT wanted.*
      FROM wanted
      JOIN "ScopeDirty" dirty ON dirty."scopeKind" = wanted.kind AND dirty."scopeKey" = wanted.key
        AND dirty."claimToken" = wanted.token
      ORDER BY dirty."scopeKind", dirty."scopeKey" FOR UPDATE OF dirty
    ), settled AS (
      UPDATE "ScopeDirty" dirty
      SET "claimToken" = NULL, "claimDeadline" = NULL,
        "availableAt" = now() + make_interval(secs => owned.delay),
        "waitCause" = NULL, "lastError" = ${error}
      FROM owned
      WHERE dirty."scopeKind" = owned.kind AND dirty."scopeKey" = owned.key
        AND dirty."claimToken" = owned.token
      RETURNING dirty."scopeKind", dirty."scopeKey"
    )
    INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage, "errorClass", error)
    SELECT "scopeKind", "scopeKey", ${version}, ${rules}, ${kernelStage.enum.waiting}, 'transient', ${error}
    FROM settled
    ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE
    SET "errorClass" = excluded."errorClass", error = excluded.error`);
}

export type ClaimedScope = {
  kind: string;
  key: string;
  seq: number;
  attempts: number;
  conflicts: number;
  dirtiedAt: Date;
  token: string;
  deadline: Date;
};

/** A row whose claim admits a holder now: free, or held past its deadline. */
const freeNow = (t: SQL): SQL =>
  sql`${t}."availableAt" <= now() AND (${t}."claimToken" IS NULL OR ${t}."claimDeadline" <= now())`;

/**
 * When `freeNow` first holds for a row: its `availableAt`, or for a held
 * claim the later of that and the claim deadline. A held row without a
 * deadline never frees, so it has no time.
 */
const freeAt = (t: SQL): SQL =>
  sql`CASE WHEN ${t}."claimToken" IS NULL THEN ${t}."availableAt"
    WHEN ${t}."claimDeadline" IS NOT NULL THEN greatest(${t}."availableAt", ${t}."claimDeadline") END`;

/** Dirty rows a runner may claim now. */
const claimableScope = (d: SQL): SQL =>
  sql`${d}.attempts < ${MAX_SCOPE_ATTEMPTS} AND ${freeNow(d)}`;

/**
 * Asks of these features the background runner claims once free: queued,
 * run by this Worker's producer (not hosted, no external executor), with
 * attempts left and a waiter that still wants the answer. An Ask nobody waits
 * on is its in-line caller's to retry.
 */
const runnerAsk = (a: SQL, features: readonly string[]): SQL =>
  sql`${a}.state = ${ASK.queued} AND NOT ${a}.hosted AND ${a}.executor IS NULL AND ${a}."cancelledAt" IS NULL
    AND ${a}.attempts < ${a}."maxAttempts" AND ${a}.feature = ANY(${textArrayParam(features)})
    AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = ${a}.id AND s."cancelledAt" IS NULL)`;

/** Unfinished Passes of these names with attempts left; exhausted ones wait for a member retry. */
const runnerPass = (p: SQL, names: readonly string[]): SQL =>
  sql`${p}."doneAt" IS NULL AND ${p}."cancelledAt" IS NULL AND ${p}.attempts < ${p}."maxAttempts"
    AND ${p}.name = ANY(${textArrayParam(names)})`;

/** The Ask kinds the background runner produces. */
export const runnerAskKinds = (registry: KernelRegistry): AskKind[] =>
  [...registry.asks.values()].filter((kind) => kind.produce && !kind.hosted);

/** Scope kinds in claim order: money lane first, upstream kinds first. */
export const scopeClaimOrder = (registry: KernelRegistry): Reconciler[] =>
  [...registry.reconcilers.values()].sort(
    (a, b) =>
      kernelLane.options.indexOf(a.lane) - kernelLane.options.indexOf(b.lane) ||
      registry.rank(a.scope) - registry.rank(b.scope) ||
      (a.scope < b.scope ? -1 : 1),
  );

/**
 * Claim up to `limit` dirty scopes of the first kind in `kinds` that has
 * claimable rows, in `availableAt`, `seq` order. Each kind's head comes from
 * `ScopeDirty_claim_idx`; the queue is never read whole. The caller's order is
 * the whole scheduling preference: no kind waits on another's backlog.
 */
export async function claimScopeBatch(
  q: Q,
  kinds: readonly Reconciler[],
  limit: number,
  only?: readonly { kind: string; key: string }[],
): Promise<ClaimedScope[]> {
  if (!kinds.length) return [];
  const token = crypto.randomUUID();
  const order = sql.join(
    kinds.map(
      (reconciler, position) =>
        sql`(${reconciler.scope}::text, ${reconciler.lane}::text, ${position}::int)`,
    ),
    sql`, `,
  );
  // A member's reconcile-now names its scopes.
  const restrict = (d: SQL) =>
    only
      ? sql`AND (${d}."scopeKind", ${d}."scopeKey") IN (SELECT o.kind, o.key FROM jsonb_to_recordset(${JSON.stringify(only)}::jsonb) AS o(kind text, key text))`
      : sql``;
  const result = await q.execute<{
    scopeKind: string;
    scopeKey: string;
    seq: string | number;
    attempts: number;
    conflicts: number;
    updatedAt: string;
    deadline: string;
  }>(sql`
    WITH kinds (kind, lane, position) AS (VALUES ${order}),
    chosen AS MATERIALIZED (
      SELECT kinds.kind, kinds.lane FROM kinds WHERE EXISTS (
        SELECT 1 FROM "ScopeDirty" d
        WHERE d.lane = kinds.lane AND d."scopeKind" = kinds.kind AND ${claimableScope(sql`d`)} ${restrict(sql`d`)}
      ) ORDER BY kinds.position LIMIT 1
    ), picked AS (
      -- The limit applies after locked rows are skipped, and the predicates are rechecked under each row lock.
      SELECT d."scopeKind", d."scopeKey" FROM "ScopeDirty" d
      WHERE d.lane = (SELECT lane FROM chosen) AND d."scopeKind" = (SELECT kind FROM chosen)
        AND ${claimableScope(sql`d`)} ${restrict(sql`d`)}
      ORDER BY d."availableAt", d.seq LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "ScopeDirty" d SET "claimToken" = ${token}::uuid,
      "claimDeadline" = now() + ${leaseInterval(CLAIM_LEASE_MS)}, "claimedSeq" = d.seq
    FROM picked WHERE d."scopeKind" = picked."scopeKind" AND d."scopeKey" = picked."scopeKey"
    RETURNING d."scopeKind", d."scopeKey", d.seq, d.attempts, d.conflicts,
      ${isoText(sql`d."updatedAt"`)} AS "updatedAt", ${isoText(sql`d."claimDeadline"`)} AS deadline`);
  return result.rows.map((row) => ({
    kind: row.scopeKind,
    key: row.scopeKey,
    seq: Number(row.seq),
    attempts: row.attempts,
    conflicts: row.conflicts,
    dirtiedAt: fromIso(row.updatedAt) ?? new Date(),
    deadline: new Date(row.deadline),
    token,
  }));
}

/** Claim from one lane, upstream kinds first. */
export const claimScopes = (
  q: Q,
  registry: KernelRegistry,
  lane: string,
  limit: number,
  only?: readonly { kind: string; key: string }[],
): Promise<ClaimedScope[]> =>
  claimScopeBatch(
    q,
    scopeClaimOrder(registry).filter((reconciler) => reconciler.lane === lane),
    limit,
    only,
  );

/** Serialize only slot admission; no network work holds this transaction. */
async function withPartition<T>(
  db: Database,
  limit: ClaimLimit | undefined,
  empty: T,
  work: (q: Q, available: number) => Promise<T>,
  full?: (q: Q) => Promise<boolean>,
): Promise<T> {
  if (!limit) return work(repositoryQueries(db), Number.MAX_SAFE_INTEGER);
  if (!limit.partition || !Number.isInteger(limit.slots) || limit.slots < 1)
    throw new Error("Invalid claim partition");
  let parked = false;
  const result = await repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    await q.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('kernel.partition:' || ${limit.partition}, 0))`,
    );
    const held = await q.execute<{ n: number }>(sql`SELECT (
      (SELECT count(*) FROM "Ask" WHERE "claimPartition" = ${limit.partition} AND "claimToken" IS NOT NULL AND "claimDeadline" > now() AND "cancelledAt" IS NULL)
      + (SELECT count(*) FROM "Pass" WHERE "claimPartition" = ${limit.partition} AND "claimToken" IS NOT NULL AND "claimDeadline" > now() AND "cancelledAt" IS NULL)
    )::int AS n`);
    const available = Math.max(0, limit.slots - (held.rows[0]?.n ?? 0));
    if (available) return work(q, available);
    parked = (await full?.(q)) ?? false;
    return empty;
  });
  if (parked) await wakeClaimRecovery(new Date(Date.now() + 15_000), db);
  return result;
}

/** Full partitions wait without spending attempts or spinning the runner. */
async function parkPartition(
  q: Q,
  match: SQL,
  table: "Ask" | "Pass",
  limit?: ClaimLimit,
): Promise<boolean> {
  const result = await q.execute<{
    parked: number;
  }>(sql`UPDATE ${sql.raw(`"${table}"`)} SET "claimPartition" = ${limit?.partition ?? null},
    "waitCause" = ${kernelWaitCause.enum.provider_capacity}, "availableAt" = now() + interval '15 seconds'
    WHERE ${match} AND "cancelledAt" IS NULL AND "availableAt" <= now()
      AND attempts < "maxAttempts"
      AND ${
        table === "Ask"
          ? sql`state = ${ASK.queued} AND ("claimToken" IS NULL OR "claimDeadline" <= now())`
          : sql`"doneAt" IS NULL AND ${passFreeAt(sql`"Pass"`)} <= now()`
      } RETURNING 1 AS parked`);
  return result.rows.length > 0;
}

/** Inline withAsk uses the same slot admission as queued Ask and Pass claims. */
export async function claimAsk(
  db: Database,
  id: string,
  limit?: ClaimLimit,
): Promise<{
  token: string;
  attempts: number;
  deadline: Date;
  wakeVersion: number;
} | null> {
  const token = crypto.randomUUID();
  const row = await withPartition<{
    attempts: number;
    deadline: string;
    wakeVersion: number;
  } | null>(
    db,
    limit,
    null,
    async (q) => {
      const result = await q.execute<{
        attempts: number;
        deadline: string;
        wakeVersion: number;
      }>(sql`
      UPDATE "Ask" SET "claimToken" = ${token}::uuid, "claimPartition" = ${limit?.partition ?? null},
        "claimDeadline" = now() + ${leaseInterval(CLAIM_LEASE_MS)}
      WHERE id = ${id}::uuid AND state = ${ASK.queued} AND "cancelledAt" IS NULL
        AND "availableAt" <= now() AND attempts < "maxAttempts" AND ("claimToken" IS NULL OR "claimDeadline" <= now())
      RETURNING attempts, "wakeVersion", ${isoText(sql`"claimDeadline"`)} AS deadline`);
      return result.rows[0] ?? null;
    },
    async (q) => {
      return parkPartition(q, sql`id = ${id}::uuid`, "Ask", limit);
    },
  );
  if (!row) return null;
  const deadline = new Date(row.deadline);
  await wakeClaimRecovery(deadline, db);
  return { ...row, token, deadline };
}

/** External dispatch shares Ask and Pass partition admission before marking sent. */
export async function claimExternalAskRow(
  db: Database,
  kind: AskKind,
  options: {
    id: string;
    executor: string;
    leaseMs: number;
    reclaimExpired?: boolean;
  },
): Promise<{
  id: string;
  token: string;
  input: unknown;
  deadline: Date;
} | null> {
  const token = crypto.randomUUID();
  const row = await withPartition<{
    id: string;
    input: unknown;
    deadline: string;
  } | null>(
    db,
    kind.claimLimit,
    null,
    async (q) => {
      const result = await q.execute<{
        id: string;
        input: unknown;
        deadline: string;
      }>(sql`
        UPDATE "Ask" SET state=${ASK.sent}, "sentAt"=now(), "claimToken"=${token}::uuid,
          "claimPartition"=${kind.claimLimit?.partition ?? null},
          attempts=attempts+CASE WHEN state<>${ASK.queued} THEN 1 ELSE 0 END,
          "claimDeadline"=clock_timestamp()+${leaseInterval(options.leaseMs)}, executor=${options.executor}, "waitCause"=NULL
        WHERE id=${options.id}::uuid AND feature=${kind.feature} AND "cancelledAt" IS NULL
          AND "availableAt"<=clock_timestamp() AND attempts<"maxAttempts"
          AND ((state=${ASK.queued} AND "claimToken" IS NULL) OR
            (${options.reclaimExpired === true} AND "claimToken" IS NOT NULL AND
              ((state=${ASK.sent} AND "claimDeadline"<=clock_timestamp()) OR state=${ASK.unknown})))
        RETURNING id, input, ${isoText(sql`"claimDeadline"`)} AS deadline`);
      return result.rows[0] ?? null;
    },
    async (q) => {
      return parkPartition(
        q,
        sql`id=${options.id}::uuid AND feature=${kind.feature}`,
        "Ask",
        kind.claimLimit,
      );
    },
  );
  if (!row) return null;
  const deadline = new Date(row.deadline);
  await wakeClaimRecovery(deadline, db);
  return { ...row, token, deadline };
}

export type ClaimedAsk = {
  wakeVersion: number;
  id: string;
  inputHash: string;
  feature: string;
  input: unknown;
  attempts: number;
  token: string;
  deadline: Date;
};

/** Claim queued asks whose producer this runtime can run. */
export async function claimAsks(
  db: Database,
  kinds: readonly AskKind[],
  limit: number,
): Promise<ClaimedAsk[]> {
  const groups = new Map<
    string,
    { features: string[]; limit: ClaimLimit | undefined }
  >();
  for (const kind of kinds) {
    const key = kind.claimLimit?.partition ?? "";
    const group = groups.get(key) ?? { features: [], limit: kind.claimLimit };
    if (group.limit?.slots !== kind.claimLimit?.slots)
      throw new Error("Claim partition has inconsistent slot counts");
    group.features.push(kind.feature);
    groups.set(key, group);
  }
  const claimed: ClaimedAsk[] = [];
  for (const group of groups.values()) {
    if (claimed.length >= limit) break;
    const page = await claimAskGroup(
      db,
      group.features,
      limit - claimed.length,
      group.limit,
    );
    if (page[0]) await wakeClaimRecovery(page[0].deadline, db);
    claimed.push(...page);
  }
  return claimed;
}

async function claimAskGroup(
  db: Database,
  features: readonly string[],
  count: number,
  partition?: ClaimLimit,
): Promise<ClaimedAsk[]> {
  return withPartition<ClaimedAsk[]>(
    db,
    partition,
    [],
    async (q, available) => {
      const limit = Math.min(count, available);
      const token = crypto.randomUUID();
      const result = await q.execute<{
        id: string;
        wakeVersion: number;
        inputHash: string;
        feature: string;
        input: unknown;
        attempts: number;
        deadline: string;
      }>(sql`
    WITH picked AS (
      SELECT id FROM "Ask"
      WHERE ${runnerAsk(sql`"Ask"`, features)} AND ${freeNow(sql`"Ask"`)}
      ORDER BY "availableAt", "createdAt" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Ask" a SET "claimToken" = ${token}::uuid, "claimPartition" = ${partition?.partition ?? null},
      "claimDeadline" = now() + ${leaseInterval(CLAIM_LEASE_MS)}
    FROM picked WHERE a.id = picked.id
    RETURNING a.id, a."wakeVersion", a."inputHash", a.feature, a.input, a.attempts, ${isoText(sql`a."claimDeadline"`)} AS deadline`);
      return result.rows.map((row) => ({
        ...row,
        token,
        deadline: new Date(row.deadline),
      }));
    },
    async (q) => {
      return parkPartition(
        q,
        sql`feature = ANY(${textArrayParam(features)})`,
        "Ask",
        partition,
      );
    },
  );
}

export type ClaimedPass = {
  wakeVersion: number;
  name: string;
  key: string;
  cursor: unknown;
  attempts: number;
  token: string;
  deadline: Date;
  recoveryAt: Date;
};

/** includes-deleted: priority follows the originating Run's member request. */
export const passOrder = (): SQL => sql`EXISTS (
  SELECT 1 FROM "Run" r WHERE r.id = "Pass"."runId"
    AND (r.cause = ${MEMBER_PASS.cause} OR r.trigger IN (${MEMBER_PASS.manual}, ${MEMBER_PASS.foreground}))
) DESC, "availableAt", "createdAt", name, key`;

export async function claimPass(
  db: Database,
  passes: readonly Pass[],
): Promise<ClaimedPass | null> {
  const candidates = await repositoryQueries(db).execute<{
    name: string;
  }>(sql`SELECT name FROM (SELECT name,
      row_number() OVER (PARTITION BY name ORDER BY ${passOrder()}) AS rank,
      row_number() OVER (ORDER BY ${passOrder()}) AS position FROM "Pass"
    WHERE ${runnerPass(
      sql`"Pass"`,
      passes.map((pass) => pass.name),
    )} AND ${passFreeAt(sql`"Pass"`)} <= now()
    ) ranked WHERE rank = 1 ORDER BY position`);
  for (const candidate of candidates.rows) {
    const pass = passes.find((entry) => entry.name === candidate.name);
    if (!pass) continue;
    const claimed = await claimPassGroup(db, pass);
    if (claimed) {
      await wakeClaimRecovery(claimed.recoveryAt, db);
      return claimed;
    }
  }
  return null;
}

async function claimPassGroup(
  db: Database,
  pass: Pass,
): Promise<ClaimedPass | null> {
  return withPartition<ClaimedPass | null>(
    db,
    pass.claimLimit,
    null,
    async (q) => {
      const names = [pass.name];
      const token = crypto.randomUUID();
      const result = await q.execute<{
        wakeVersion: number;
        name: string;
        key: string;
        cursor: unknown;
        attempts: number;
        deadline: string | null;
        recoveryAt: string;
      }>(sql`
    WITH picked AS (
      SELECT name, key, attempts + ("claimToken" IS NOT NULL)::int AS spent,
        "claimToken" IS NOT NULL AS lapsed, "maxAttempts"
      FROM "Pass"
      WHERE ${runnerPass(sql`"Pass"`, names)} AND ${passFreeAt(sql`"Pass"`)} <= now()
      ORDER BY ${passOrder()} LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Pass" p SET attempts = picked.spent,
      "transientFailures" = CASE WHEN picked.lapsed THEN 0 ELSE p."transientFailures" END,
      "lastError" = CASE WHEN picked.lapsed THEN ${rawError(new ClaimLapsedError())} ELSE p."lastError" END,
      "claimToken" = CASE WHEN picked.spent < picked."maxAttempts" THEN ${token}::uuid END,
      "claimPartition" = ${pass.claimLimit?.partition ?? null},
      "claimDeadline" = CASE WHEN picked.spent < picked."maxAttempts" THEN now() + ${leaseInterval(CLAIM_LEASE_MS)} END
      ${
        pass.restartFloorMs
          ? sql`, cursor = CASE WHEN picked.spent < picked."maxAttempts"
              AND NOT coalesce(p.cursor ? 'censusStartedAt', false)
            THEN coalesce(nullif(p.cursor, 'null'::jsonb), '{}'::jsonb)
              || jsonb_build_object('censusStartedAt', now()::timestamp)
            ELSE p.cursor END`
          : sql``
      }
    FROM picked WHERE p.name = picked.name AND p.key = picked.key
    RETURNING p.name, p.key, ${
      pass.restartFloorMs
        ? sql`CASE WHEN p.cursor ? 'censusStartedAt' THEN p.cursor - 'censusStartedAt' ELSE p.cursor END`
        : sql`p.cursor`
    } AS cursor, p."wakeVersion", p.attempts, ${isoText(sql`p."claimDeadline"`)} AS deadline,
      ${isoText(passRecoveryAt(sql`p`))} AS "recoveryAt"`);
      const row = result.rows[0];
      return row?.deadline
        ? {
            ...row,
            token,
            deadline: new Date(row.deadline),
            recoveryAt: new Date(row.recoveryAt),
          }
        : null;
    },
    async (q) => {
      return parkPartition(
        q,
        sql`name = ${pass.name}`,
        "Pass",
        pass.claimLimit,
      );
    },
  );
}

/**
 * The next time the runner can claim work: the least `freeAt` over the rows
 * its claim statements select, built from the same predicates
 * (`claimableScope`, `runnerAsk`, `runnerPass`), plus the deadline of a sent
 * Ask's claim, whose expiry `expireAsks` settles at the runner's start. Rows no
 * runner claim selects (exhausted, hosted, externally executed, unregistered,
 * cancelled or done work) never count, so a delivery offers a successor only
 * for claimable work. Scope heads come from `ScopeDirty_claim_idx` and held
 * claims from `ScopeDirty_held_idx`. Scalar SQL, also the drain's `next`.
 */
export const nextWakeSql = (registry: KernelRegistry): SQL => {
  const kinds = [...registry.reconcilers.values()];
  const known = sql`(VALUES ${sql.join(
    kinds.map(
      (reconciler) =>
        sql`(${reconciler.lane}::text, ${reconciler.scope}::text)`,
    ),
    sql`, `,
  )}) AS known(lane, kind)`;
  const scopes = kinds.length
    ? sql`(SELECT min(head."availableAt") FROM ${known} CROSS JOIN LATERAL (
        SELECT d."availableAt" FROM "ScopeDirty" d
        WHERE d.lane = known.lane AND d."scopeKind" = known.kind
          AND d.attempts < ${MAX_SCOPE_ATTEMPTS} AND d."claimToken" IS NULL
        ORDER BY d."availableAt", d.seq LIMIT 1) head),
    (SELECT min(${freeAt(sql`d`)}) FROM "ScopeDirty" d
      WHERE d."claimToken" IS NOT NULL AND d.attempts < ${MAX_SCOPE_ATTEMPTS}
        AND (d.lane, d."scopeKind") IN (SELECT lane, kind FROM ${known}))`
    : sql`NULL::timestamp`;
  return sql`(
  SELECT least(
    ${scopes},
    (SELECT min(${freeAt(sql`"Ask"`)}) FROM "Ask"
      WHERE ${runnerAsk(
        sql`"Ask"`,
        runnerAskKinds(registry).map((kind) => kind.feature),
      )}),
    (SELECT min("claimDeadline") FROM "Ask" WHERE state = ${ASK.sent}
      AND feature = ANY(${textArrayParam([...registry.asks.keys()])})),
    (SELECT min(${passFreeAt(sql`"Pass"`)}) FROM "Pass"
      WHERE ${runnerPass(sql`"Pass"`, [...registry.passes.keys()])})
  )::timestamp)`;
};

/**
 * Retain orphaned work for inspection without spinning the queue on
 * unclaimable rows. A dirty scope of a kind this runtime has no reconciler for
 * is reported Stuck once, through ScopeState, without spending attempts:
 * during a deploy the previous Worker meets scopes queued for the next one's
 * reconcilers, which must stay claimable once that Worker runs. Claims and the
 * next wake already skip unregistered kinds.
 */
export async function stopUnregisteredWork(
  db: Database,
  registry: KernelRegistry,
): Promise<void> {
  // Its predicates cannot use an index, so each isolate checks on an interval.
  const checked = lastUnregisteredCheck.get(registry) ?? 0;
  if (Date.now() - checked < UNREGISTERED_CHECK_MS) return;
  await repositoryQueries(db).execute(sql`
    WITH scopes AS (
      UPDATE "ScopeDirty" SET "claimToken" = NULL, "claimDeadline" = NULL,
        "lastError" = ${UNREGISTERED_RECONCILER} || "scopeKind"
      WHERE NOT ("scopeKind" = ANY(${textArrayParam([...registry.reconcilers.keys()])})) AND attempts < ${MAX_SCOPE_ATTEMPTS}
        AND "lastError" IS DISTINCT FROM ${UNREGISTERED_RECONCILER} || "scopeKind"
        AND ("claimToken" IS NULL OR "claimDeadline" <= now()) RETURNING "scopeKind", "scopeKey", "lastError"
    ), asks AS (
      UPDATE "Ask" SET attempts = "maxAttempts", "lastError" = 'Unregistered Ask kind: ' || feature,
        "claimToken" = NULL, "claimDeadline" = NULL
      WHERE NOT (feature = ANY(${textArrayParam([...registry.asks.keys()])})) AND attempts < "maxAttempts"
        AND state IN (${ASK.queued}, ${ASK.sent}) AND ("claimToken" IS NULL OR "claimDeadline" <= now())
    ), passes AS (
      UPDATE "Pass" SET attempts = "maxAttempts", "lastError" = 'Unregistered Pass: ' || name,
        "claimToken" = NULL, "claimDeadline" = NULL
      WHERE NOT (name = ANY(${textArrayParam([...registry.passes.keys()])})) AND attempts < "maxAttempts"
        AND "doneAt" IS NULL AND "cancelledAt" IS NULL AND ("claimToken" IS NULL OR "claimDeadline" <= now())
    ) INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage, "errorClass", error)
      SELECT "scopeKind", "scopeKey", 0, 'unregistered', ${"stuck"}, ${"failed"}, "lastError" FROM scopes
      ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET stage = ${"stuck"}, "errorClass" = ${"failed"}, error = excluded.error`);
  lastUnregisteredCheck.set(registry, Date.now());
}

/** Clear funding waits atomically; version live holders so an older refusal cannot put them back. */
export async function releaseFundingWaits(
  db: Database,
  now = new Date(),
): Promise<number> {
  // Reset is immediate in database time, even when the caller’s clock is ahead.
  const available = sql`least(${now.toISOString()}::timestamp, now())`;
  const result = await repositoryQueries(db).execute<{ n: number }>(sql`
    WITH asks AS (
      UPDATE "Ask" SET "availableAt" = CASE WHEN "waitCause" = ${kernelWaitCause.enum.funding} THEN ${available} ELSE "availableAt" END,
        "waitCause" = CASE WHEN "waitCause" = ${kernelWaitCause.enum.funding} THEN NULL ELSE "waitCause" END,
        "wakeVersion" = "wakeVersion" + 1, "updatedAt" = ${now.toISOString()}::timestamp
      WHERE state IN (${ASK.queued}, ${ASK.sent}) AND "cancelledAt" IS NULL
        AND ("waitCause" = ${kernelWaitCause.enum.funding} OR "claimToken" IS NOT NULL)
      RETURNING id
    ), passes AS (
      UPDATE "Pass" SET "availableAt" = ${available},
        "waitCause" = CASE WHEN "waitCause" = ${kernelWaitCause.enum.funding} THEN NULL ELSE "waitCause" END,
        "wakeVersion" = "wakeVersion" + 1, "updatedAt" = ${now.toISOString()}::timestamp
      WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL
        AND "waitCause" = ${kernelWaitCause.enum.funding}
        AND ("claimToken" IS NULL OR "claimDeadline" <= now())
      RETURNING name
    ) SELECT ((SELECT count(*) FROM asks) + (SELECT count(*) FROM passes))::int AS n`);
  return result.rows[0]?.n ?? 0;
}

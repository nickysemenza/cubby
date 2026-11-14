/**
 * The one claim module for the kernel's three work forms (ADR 0029 section
 * 7): a dirty scope, an Ask, a Pass. A claim is a token with a deadline; it
 * renews, counts attempts, backs off through `availableAt`, waits with a
 * cause, honours cancellation, and is classified by the single failure
 * classifier. A claim past its deadline cannot publish: every publishing
 * write checks the token and a live deadline under a row lock.
 */
import type { ExecutionWaitReason } from "@cubby/schemas/execution";
import type { KernelWaitCause } from "@cubby/schemas/kernel/machinery";
import {
  kernelWaitCause,
  MACHINERY_RAW_ERROR_BYTES,
} from "@cubby/schemas/kernel/machinery";
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
import { WorkSupersededError } from "~/server/kernel/work-errors";

import type { AskKind, ClaimLimit, Pass } from "./define";
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
/** Non-transient failures before a dirty scope is Stuck. */
export const MAX_SCOPE_ATTEMPTS = 5;
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

/** Attempt `n`'s backoff: 30 s doubling to an hour. */
const backoffMs = (attempts: number) =>
  Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

const WAIT_CAUSE = {
  provider_capacity: "provider_capacity",
  ai_funding_window: "funding",
  device: "device",
  rate_limit: "rate_limit",
} satisfies Record<ExecutionWaitReason, KernelWaitCause>;

/** A raw error's stored form: scrubbed causes, capped at 16 KB. */
export function rawError(error: UnparsedError): string {
  const text = JSON.stringify(describeErrorCauses(error));
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
 * Settle a failed claim through the single classifier. A wait or a transient
 * failure spends no attempt; a lost claim settles nothing; anything else
 * spends one and backs off. Returns the classification.
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
  const owned = sql`${identity(target)} AND "claimToken" = ${token}::uuid`;
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
    case "transient":
      await q.execute(sql`
        UPDATE ${tableOf(target)} SET "claimToken" = NULL, "claimDeadline" = NULL,
          "availableAt" = now() + ${leaseInterval(backoffMs(attempts + 1))},
          "waitCause" = NULL, "lastError" = ${raw}
        WHERE ${owned}`);
      return failure;
    case "isolated":
    case "failed":
      await q.execute(sql`
        UPDATE ${tableOf(target)} SET "claimToken" = NULL, "claimDeadline" = NULL,
          attempts = attempts + 1,
          "availableAt" = now() + ${leaseInterval(backoffMs(attempts + 1))},
          "waitCause" = NULL, "lastError" = ${raw}
        WHERE ${owned}`);
      return failure;
  }
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

/**
 * Claim up to `limit` dirty scopes of one kind in `lane`, in the order the
 * runner always claims: upstream rank, `availableAt`, `seq`. A kind waits
 * while a claimable dirty scope of an upstream kind in its lane exists.
 */
export async function claimScopes(
  q: Q,
  registry: KernelRegistry,
  lane: string,
  limit: number,
  only?: readonly { kind: string; key: string }[],
): Promise<ClaimedScope[]> {
  const kinds = [...registry.reconcilers.values()].filter(
    (reconciler) => reconciler.lane === lane,
  );
  if (!kinds.length) return [];
  const token = crypto.randomUUID();
  const ranks = sql.join(
    kinds.map(
      (reconciler) =>
        sql`(${reconciler.scope}::text, ${registry.rank(reconciler.scope)}::int, ${textArrayParam(registry.upstream(reconciler.scope))})`,
    ),
    sql`, `,
  );
  const restrict = only
    ? sql`AND (d."scopeKind", d."scopeKey") IN (SELECT o.kind, o.key FROM jsonb_to_recordset(${JSON.stringify(only)}::jsonb) AS o(kind text, key text))`
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
    WITH ranks (kind, rank, upstream) AS (VALUES ${ranks}),
    claimable AS (
      SELECT d."scopeKind", d."scopeKey", d."availableAt", d.seq, ranks.rank, ranks.upstream
      FROM "ScopeDirty" d JOIN ranks ON ranks.kind = d."scopeKind"
      WHERE d.lane = ${lane} AND d."availableAt" <= now()
        AND d.attempts < ${MAX_SCOPE_ATTEMPTS}
        AND (d."claimToken" IS NULL OR d."claimDeadline" <= now()) ${restrict}
    ), claimable_kinds AS MATERIALIZED (
      SELECT DISTINCT "scopeKind" FROM claimable
    ), eligible AS (
      SELECT c.* FROM claimable c
      WHERE NOT EXISTS (SELECT 1 FROM claimable_kinds u WHERE u."scopeKind" = ANY(c.upstream))
    ), chosen AS (
      SELECT "scopeKind" FROM eligible ORDER BY rank, "availableAt", seq LIMIT 1
    ), picked AS (
      SELECT d."scopeKind", d."scopeKey" FROM "ScopeDirty" d
      WHERE (d."scopeKind", d."scopeKey") IN (
        SELECT e."scopeKind", e."scopeKey" FROM eligible e
        WHERE e."scopeKind" = (SELECT "scopeKind" FROM chosen)
        ORDER BY e."availableAt", e.seq LIMIT ${limit})
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
  if (parked) await wakeClaimRecovery(new Date(Date.now() + 15_000));
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
      AND attempts < "maxAttempts" AND ("claimToken" IS NULL OR "claimDeadline" <= now())
      AND ${table === "Ask" ? sql`state = ${ASK.queued}` : sql`"doneAt" IS NULL`} RETURNING 1 AS parked`);
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
  await wakeClaimRecovery(deadline);
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
  await wakeClaimRecovery(deadline);
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
    if (page[0]) await wakeClaimRecovery(page[0].deadline);
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
      WHERE state = ${ASK.queued} AND NOT hosted AND executor IS NULL AND "cancelledAt" IS NULL AND "availableAt" <= now()
        AND attempts < "maxAttempts" AND feature = ANY(${textArrayParam(features)})
        AND ("claimToken" IS NULL OR "claimDeadline" <= now())
        -- An ask nobody waits on is its in-line caller's to retry.
        AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = "Ask".id AND s."cancelledAt" IS NULL)
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
    WHERE name = ANY(${textArrayParam(passes.map((pass) => pass.name))}) AND "doneAt" IS NULL AND "cancelledAt" IS NULL
      AND attempts < "maxAttempts" AND "availableAt" <= now() AND ("claimToken" IS NULL OR "claimDeadline" <= now())
    ) ranked WHERE rank = 1 ORDER BY position`);
  for (const candidate of candidates.rows) {
    const pass = passes.find((entry) => entry.name === candidate.name);
    if (!pass) continue;
    const claimed = await claimPassGroup(db, pass);
    if (claimed) {
      await wakeClaimRecovery(claimed.deadline);
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
        deadline: string;
      }>(sql`
    WITH picked AS (
      SELECT name, key FROM "Pass"
      WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL AND "availableAt" <= now()
        AND attempts < "maxAttempts" AND name = ANY(${textArrayParam(names)})
        AND ("claimToken" IS NULL OR "claimDeadline" <= now())
      ORDER BY ${passOrder()} LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Pass" p SET "claimToken" = ${token}::uuid, "claimPartition" = ${pass.claimLimit?.partition ?? null},
      "claimDeadline" = now() + ${leaseInterval(CLAIM_LEASE_MS)}
    FROM picked WHERE p.name = picked.name AND p.key = picked.key
    RETURNING p.name, p.key, p.cursor, p."wakeVersion", p.attempts, ${isoText(sql`p."claimDeadline"`)} AS deadline`);
      const row = result.rows[0];
      return row ? { ...row, token, deadline: new Date(row.deadline) } : null;
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
 * The next wake across the three tables: the least `availableAt` of claimable
 * work, or the deadline of a claim that would lapse into claimable work.
 * Scalar SQL, also the drain's `next`.
 */
export const nextWakeSql = (registry?: KernelRegistry): SQL => sql`(
  SELECT least(
    (SELECT min(CASE WHEN "claimToken" IS NULL THEN "availableAt" ELSE greatest("availableAt", "claimDeadline") END)
      FROM "ScopeDirty" WHERE attempts < ${MAX_SCOPE_ATTEMPTS}
        ${registry ? sql`AND "scopeKind" = ANY(${textArrayParam([...registry.reconcilers.keys()])})` : sql``}),
    (SELECT min(CASE WHEN "claimToken" IS NULL THEN "availableAt" ELSE greatest("availableAt", "claimDeadline") END)
      FROM "Ask" WHERE state = ${ASK.queued} AND "cancelledAt" IS NULL AND executor IS NULL AND NOT hosted AND attempts < "maxAttempts"
        ${registry ? sql`AND feature = ANY(${textArrayParam([...registry.asks.values()].filter((kind) => kind.produce && !kind.hosted).map((kind) => kind.feature))})` : sql``}
        AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = "Ask".id AND s."cancelledAt" IS NULL)),
    (SELECT min("claimDeadline") FROM "Ask" WHERE state = ${ASK.sent}
      ${registry ? sql`AND feature = ANY(${textArrayParam([...registry.asks.keys()])})` : sql``}),
    (SELECT min(CASE WHEN "claimToken" IS NULL THEN "availableAt" ELSE greatest("availableAt", "claimDeadline") END)
      FROM "Pass" WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL AND attempts < "maxAttempts"
        ${registry ? sql`AND name = ANY(${textArrayParam([...registry.passes.keys()])})` : sql``})
  )::timestamp)`;

/** Retain orphaned work for inspection without spinning the queue on unclaimable rows. */
export async function stopUnregisteredWork(
  db: Database,
  registry: KernelRegistry,
): Promise<void> {
  await repositoryQueries(db).execute(sql`
    WITH scopes AS (
      UPDATE "ScopeDirty" SET attempts = ${MAX_SCOPE_ATTEMPTS}, "claimToken" = NULL, "claimDeadline" = NULL,
        "lastError" = 'Unregistered reconciler: ' || "scopeKind"
      WHERE NOT ("scopeKind" = ANY(${textArrayParam([...registry.reconcilers.keys()])})) AND attempts < ${MAX_SCOPE_ATTEMPTS}
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

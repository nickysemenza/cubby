/**
 * The one claim module for the kernel's three work forms (ADR 0029 section
 * 7): a dirty scope, an Ask, a Pass. A claim is a token with a deadline; it
 * renews, counts attempts, backs off through `availableAt`, waits with a
 * cause, honours cancellation, and is classified by the single failure
 * classifier. A claim past its deadline cannot publish: every publishing
 * write checks the token and a live deadline under a row lock.
 */
import type { JobWaitReason } from "@cubby/schemas/job";
import type { KernelWaitCause } from "@cubby/schemas/kernel/machinery";
import { MACHINERY_RAW_ERROR_BYTES } from "@cubby/schemas/kernel/machinery";
import { sql, type SQL } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import { textArrayParam } from "~/server/db/helpers/array-param";
import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import {
  classifyJobFailure,
  type JobFailure,
} from "~/server/generic/jobs/failure";

import type { KernelRegistry } from "./registry";
import { fromIso, isoText } from "./sql-time";
import { ASK, MEMBER_PASS } from "./vocab";
import { wakeClaimRecovery } from "./wake";

type Q = Pick<RepositoryQueryClient, "execute">;

export const CLAIM_LEASE_MS = 90_000;
/** Non-transient failures before a dirty scope is Stuck. */
export const MAX_SCOPE_ATTEMPTS = 5;
/** Consecutive `seq`/`rev` conflicts before a scope runs locked. */
export const LOCKED_RUN_AFTER_CONFLICTS = 3;

/** A claim lapsed or was cancelled; its holder must not publish. */
export class ClaimLapsedError extends JobSupersededError {
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
export const backoffMs = (attempts: number) =>
  Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

const WAIT_CAUSE = {
  provider_capacity: "provider_capacity",
  ai_funding_window: "funding",
  device: "device",
  rate_limit: "rate_limit",
} satisfies Record<JobWaitReason, KernelWaitCause>;

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
  if (row) await wakeClaimRecovery(new Date(row.deadline));
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
): Promise<JobFailure> {
  const failure = classifyJobFailure(error);
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
      await q.execute(sql`
        UPDATE ${tableOf(target)} SET "claimToken" = NULL, "claimDeadline" = NULL,
          "availableAt" = ${until.toISOString()}::timestamp, "waitCause" = ${cause},
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
    ), eligible AS (
      SELECT c.* FROM claimable c
      WHERE NOT EXISTS (SELECT 1 FROM claimable u WHERE u."scopeKind" = ANY(c.upstream))
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
  if (result.rows[0])
    await wakeClaimRecovery(new Date(result.rows[0].deadline));
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

/** A conflict spends no attempt; it counts toward the locked-run fallback. */
export async function recordConflict(q: Q, scope: ClaimedScope): Promise<void> {
  await q.execute(sql`
    UPDATE "ScopeDirty" SET "claimToken" = NULL, "claimDeadline" = NULL,
      conflicts = conflicts + 1
    WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}
      AND "claimToken" = ${scope.token}::uuid`);
}

export type ClaimedAsk = {
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
  q: Q,
  features: readonly string[],
  limit: number,
): Promise<ClaimedAsk[]> {
  if (!features.length) return [];
  const token = crypto.randomUUID();
  const result = await q.execute<{
    id: string;
    inputHash: string;
    feature: string;
    input: unknown;
    attempts: number;
    deadline: string;
  }>(sql`
    WITH picked AS (
      SELECT id FROM "Ask"
      WHERE state = ${ASK.queued} AND "cancelledAt" IS NULL AND "availableAt" <= now()
        AND attempts < "maxAttempts" AND feature = ANY(${textArrayParam(features)})
        AND ("claimToken" IS NULL OR "claimDeadline" <= now())
        -- An ask nobody waits on is its in-line caller's to retry.
        AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = "Ask".id)
      ORDER BY "availableAt", "createdAt" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Ask" a SET "claimToken" = ${token}::uuid,
      "claimDeadline" = now() + ${leaseInterval(CLAIM_LEASE_MS)}
    FROM picked WHERE a.id = picked.id
    RETURNING a.id, a."inputHash", a.feature, a.input, a.attempts, ${isoText(sql`a."claimDeadline"`)} AS deadline`);
  if (result.rows[0])
    await wakeClaimRecovery(new Date(result.rows[0].deadline));
  return result.rows.map((row) => ({
    ...row,
    token,
    deadline: new Date(row.deadline),
  }));
}

export type ClaimedPass = {
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
  q: Q,
  names: readonly string[],
): Promise<ClaimedPass | null> {
  if (!names.length) return null;
  const token = crypto.randomUUID();
  const result = await q.execute<{
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
    UPDATE "Pass" p SET "claimToken" = ${token}::uuid,
      "claimDeadline" = now() + ${leaseInterval(CLAIM_LEASE_MS)}
    FROM picked WHERE p.name = picked.name AND p.key = picked.key
    RETURNING p.name, p.key, p.cursor, p.attempts, ${isoText(sql`p."claimDeadline"`)} AS deadline`);
  const row = result.rows[0];
  if (row) await wakeClaimRecovery(new Date(row.deadline));
  return row ? { ...row, token, deadline: new Date(row.deadline) } : null;
}

/**
 * The next wake across the three tables: the least `availableAt` of claimable
 * work, or the deadline of a claim that would lapse into claimable work.
 * Scalar SQL, also the drain's `next`.
 */
export const nextWakeSql = (): SQL => sql`(
  SELECT least(
    (SELECT min(CASE WHEN "claimToken" IS NULL THEN "availableAt" ELSE greatest("availableAt", "claimDeadline") END)
      FROM "ScopeDirty" WHERE attempts < ${MAX_SCOPE_ATTEMPTS}),
    (SELECT min(CASE WHEN "claimToken" IS NULL THEN "availableAt" ELSE greatest("availableAt", "claimDeadline") END)
      FROM "Ask" WHERE state = ${ASK.queued} AND "cancelledAt" IS NULL AND attempts < "maxAttempts"
        AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = "Ask".id)),
    (SELECT min("claimDeadline") FROM "Ask" WHERE state = ${ASK.sent}),
    (SELECT min(CASE WHEN "claimToken" IS NULL THEN "availableAt" ELSE greatest("availableAt", "claimDeadline") END)
      FROM "Pass" WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL AND attempts < "maxAttempts")
  )::timestamp)`;

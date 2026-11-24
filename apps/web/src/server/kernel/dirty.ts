/**
 * Dirtying (ADR 0029 section 5). Every input mutation, in its own
 * transaction, raises `KeyRev` for each of its keys before it reads
 * `ScopeDep`, then raises `ScopeDirty.seq` for every scope that read one of
 * those keys or that the row discovers. An apply admits the household write
 * gate (section 6), then reads the same keys' revisions in a later statement
 * before registering dependencies, so a load's dependency registration and a
 * concurrent mutation serialize through the gate: either the apply sees the
 * mutation and conflicts, or the mutation sees the committed `ScopeDep` and
 * dirties. Only a raise writes `KeyRev`; an absent key reads 0.
 *
 * Each statement here that raises `KeyRev` or locks `ScopeDirty` first takes
 * the gate, so transactions that mutate kernel inputs never interleave their
 * kernel locks.
 */
import { sql } from "drizzle-orm";

import { textArrayParam } from "~/server/db/helpers/array-param";
import { kernelApplyScopes } from "~/server/db/kernel-apply-context";
import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

import type { Key, ScopeRef } from "./define";
import { holdsHouseholdGate, takeHouseholdGate } from "./gate";
import type { KernelRegistry } from "./registry";

type Q = Pick<RepositoryQueryClient, "execute">;

/** Raise each key's revision, in key order so overlapping sets cannot deadlock. */
async function raiseKeys(q: Q, keys: readonly Key[]): Promise<void> {
  if (!keys.length) return;
  await q.execute(sql`
    WITH gate AS MATERIALIZED (SELECT ${takeHouseholdGate})
    INSERT INTO "KeyRev" (key, rev)
    SELECT key, 1 FROM unnest(${textArrayParam(keys)}) AS keys(key), gate ORDER BY key
    ON CONFLICT (key) DO UPDATE SET rev = "KeyRev".rev + 1`);
}

/**
 * Every requested key's revision behind the held household write gate; an
 * absent key reads 0. An earlier statement of this transaction must have
 * admitted the gate: this statement's snapshot then includes every raise the
 * gate admitted before it, and no raise of these keys can commit until this
 * transaction ends. Refuses when the gate is not held.
 */
export async function readGatedKeyRevs(
  q: Q,
  keys: readonly Key[],
): Promise<Map<Key, number>> {
  const revs = new Map<Key, number>(keys.map((key) => [key, 0]));
  if (!keys.length) return revs;
  const result = await q.execute<{
    held: boolean;
    revs: Record<string, string | number>;
  }>(sql`
    SELECT ${holdsHouseholdGate} AS held, coalesce(
      (SELECT jsonb_object_agg(key, rev) FROM "KeyRev" WHERE key = ANY(${textArrayParam(keys)})),
      '{}'::jsonb) AS revs`);
  const row = result.rows[0];
  if (!row?.held)
    throw new Error(
      "A revision fence reads after the household write gate; admit the gate in an earlier statement of this transaction",
    );
  for (const [key, rev] of Object.entries(row.revs)) revs.set(key, Number(rev));
  return revs;
}

/** Current revisions without the gate; an absent key reads 0. */
export async function readKeyRevs(
  q: Q,
  keys: readonly Key[],
): Promise<Map<Key, number>> {
  const revs = new Map<Key, number>(keys.map((key) => [key, 0]));
  if (!keys.length) return revs;
  const result = await q.execute<{ key: string; rev: string | number }>(sql`
    SELECT key, rev FROM "KeyRev" WHERE key = ANY(${textArrayParam(keys)})`);
  for (const row of result.rows) revs.set(row.key, Number(row.rev));
  return revs;
}

export type DirtyInput = {
  keys: readonly Key[];
  discovers?: readonly ScopeRef[];
  /** A reconciler's own output never dirties its own scope. */
  exclude?: ScopeRef;
  /** A coherent batch publishes its snapshot together. */
  excludes?: readonly ScopeRef[];
  reason: string;
};

/**
 * Raise the keys, then upsert `ScopeDirty` for every scope that read one of
 * them or that the mutation discovers. A new input clears attempts and backoff:
 * the scope runs again under the current rules. Unregistered scope kinds are
 * skipped. Returns how many scopes were dirtied.
 */
export async function markDirty(
  q: Q,
  registry: KernelRegistry,
  input: DirtyInput,
): Promise<number> {
  await raiseKeys(q, input.keys);
  const kinds = [...registry.reconcilers.values()];
  if (!kinds.length) return 0;
  const lanes = sql.join(
    kinds.map(
      (reconciler) =>
        sql`(${reconciler.scope}::text, ${reconciler.lane}::text)`,
    ),
    sql`, `,
  );
  const discovered = JSON.stringify(
    (input.discovers ?? []).map((scope) => ({
      kind: scope.kind,
      key: scope.key,
    })),
  );
  const result = await q.execute<{ n: string | number }>(sql`
    WITH gate AS MATERIALIZED (SELECT ${takeHouseholdGate}),
    lanes (kind, lane) AS (VALUES ${lanes}),
    targets AS (
      SELECT dep."scopeKind" AS kind, dep."scopeKey" AS key FROM "ScopeDep" dep
      WHERE ${input.keys.length ? sql`dep.key = ANY(${textArrayParam(input.keys)})` : sql`false`}
      UNION
      SELECT found.kind, found.key FROM jsonb_to_recordset(${discovered}::jsonb) AS found(kind text, key text)
    ), upserted AS (
      INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, seq, reason, "availableAt")
      SELECT targets.kind, targets.key, lanes.lane, 1, ${input.reason}, now()
      FROM targets JOIN lanes ON lanes.kind = targets.kind CROSS JOIN gate
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${JSON.stringify([...(input.excludes ?? []), ...(input.exclude ? [input.exclude] : []), ...kernelApplyScopes()])}::jsonb) AS excluded(kind text, key text)
        WHERE excluded.kind = targets.kind AND excluded.key = targets.key
      )
      ORDER BY targets.kind, targets.key
      ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
        seq = "ScopeDirty".seq + 1,
        reason = excluded.reason,
        attempts = 0,
        "availableAt" = LEAST("ScopeDirty"."availableAt", now()),
        "waitCause" = NULL,
        "updatedAt" = now()
      RETURNING 1
    )
    SELECT count(*) AS n FROM upserted`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Record the keys a fact is read by, so `Reads.facts` finds it. */
export async function insertFactKeys(
  q: Q,
  facts: readonly { kind: string; id: string; keys: readonly Key[] }[],
): Promise<void> {
  const rows = facts.flatMap((fact) =>
    [...new Set(fact.keys)].map((key) => ({
      key,
      kind: fact.kind,
      id: fact.id,
    })),
  );
  if (!rows.length) return;
  await q.execute(sql`
    INSERT INTO "FactKey" (key, "factKind", "factId")
    SELECT row.key, row.kind, row.id
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS row(key text, kind text, id text)
    ON CONFLICT DO NOTHING`);
}

/**
 * Replace the fact keys of the `replaced` facts of one kind with `facts` in
 * one statement, and return the keys the `previousOf` facts had. Kept keys
 * are rewritten as a fresh insert writes them; dropped keys are deleted. The
 * delete and the insert touch disjoint rows, so their order within the
 * statement does not matter.
 */
export async function replaceFactKeys(
  q: Q,
  kind: string,
  replaced: readonly string[],
  facts: readonly { id: string; keys: readonly Key[] }[],
  previousOf: readonly string[] = replaced,
): Promise<Key[]> {
  const rows = facts.flatMap((fact) =>
    [...new Set(fact.keys)].map((key) => ({ key, id: fact.id })),
  );
  const result = await q.execute<{ key: string }>(sql`
    WITH previous AS MATERIALIZED (
      SELECT key FROM "FactKey"
      WHERE "factKind" = ${kind} AND "factId" = ANY(${textArrayParam(previousOf)})
    ), next AS MATERIALIZED (
      SELECT DISTINCT row.key, row.id
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS row(key text, id text)
    ), dropped AS (
      DELETE FROM "FactKey" fact
      WHERE fact."factKind" = ${kind} AND fact."factId" = ANY(${textArrayParam(replaced)})
        AND NOT EXISTS (
          SELECT 1 FROM next WHERE next.key = fact.key AND next.id = fact."factId"
        )
    ), kept AS (
      INSERT INTO "FactKey" (key, "factKind", "factId")
      SELECT next.key, ${kind}, next.id FROM next
      ON CONFLICT (key, "factKind", "factId") DO UPDATE SET "createdAt" = excluded."createdAt"
    )
    SELECT key FROM previous`);
  return result.rows.map((row) => row.key);
}

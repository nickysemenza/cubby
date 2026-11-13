/**
 * Dirtying (ADR 0029 section 5). Every input mutation, in its own
 * transaction, raises `KeyRev` for each of its keys before it reads
 * `ScopeDep`, then raises `ScopeDirty.seq` for every scope that read one of
 * those keys or that the row discovers. An apply locks the same `KeyRev` rows
 * in the same upsert form, so a load's dependency registration and a
 * concurrent mutation serialize per key: either the apply sees the mutation
 * and conflicts, or the mutation sees the committed `ScopeDep` and dirties.
 */
import { sql } from "drizzle-orm";

import { textArrayParam } from "~/server/db/helpers/array-param";
import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

import type { Key, ScopeRef } from "./define";
import type { KernelRegistry } from "./registry";

type Q = Pick<RepositoryQueryClient, "execute">;

/** Raise each key's revision, in key order so overlapping sets cannot deadlock. */
async function raiseKeys(q: Q, keys: readonly Key[]): Promise<void> {
  if (!keys.length) return;
  await q.execute(sql`
    INSERT INTO "KeyRev" (key, rev)
    SELECT key, 1 FROM unnest(${textArrayParam(keys)}) AS keys(key) ORDER BY key
    ON CONFLICT (key) DO UPDATE SET rev = "KeyRev".rev + 1`);
}

/**
 * Lock each key's revision row, creating an absent one at 0, and return the
 * revisions. The no-op update takes the same row lock a mutation's raise does.
 */
export async function lockKeyRevs(
  q: Q,
  keys: readonly Key[],
): Promise<Map<Key, number>> {
  if (!keys.length) return new Map();
  const result = await q.execute<{ key: string; rev: string | number }>(sql`
    INSERT INTO "KeyRev" (key, rev)
    SELECT key, 0 FROM unnest(${textArrayParam(keys)}) AS keys(key) ORDER BY key
    ON CONFLICT (key) DO UPDATE SET rev = "KeyRev".rev
    RETURNING key, rev`);
  return new Map(result.rows.map((row) => [row.key, Number(row.rev)]));
}

/** Current revisions without locking; an absent key reads 0. */
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
    WITH lanes (kind, lane) AS (VALUES ${lanes}),
    targets AS (
      SELECT dep."scopeKind" AS kind, dep."scopeKey" AS key FROM "ScopeDep" dep
      WHERE ${input.keys.length ? sql`dep.key = ANY(${textArrayParam(input.keys)})` : sql`false`}
      UNION
      SELECT found.kind, found.key FROM jsonb_to_recordset(${discovered}::jsonb) AS found(kind text, key text)
    ), upserted AS (
      INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, seq, reason, "availableAt")
      SELECT targets.kind, targets.key, lanes.lane, 1, ${input.reason}, now()
      FROM targets JOIN lanes ON lanes.kind = targets.kind
      WHERE ${input.exclude ? sql`NOT (targets.kind = ${input.exclude.kind} AND targets.key = ${input.exclude.key})` : sql`true`}
      ORDER BY targets.kind, targets.key
      ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
        seq = "ScopeDirty".seq + 1,
        reason = excluded.reason,
        attempts = 0,
        "availableAt" = now(),
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

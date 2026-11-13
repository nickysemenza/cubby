import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  entityStoredDerivedDeclarations,
  type EntityStoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  computedDecision,
  validateComputedResult,
  type DerivedComputed,
} from "~/server/generic/derived/repo/compute";
import type { SnapshotCursor } from "~/server/generic/derived/repo/snapshot-state";
import {
  DERIVED_SNAPSHOT_KEY,
  DERIVED_SNAPSHOT_PASS,
} from "~/server/generic/derived/repo/snapshot-state";
import type { Claim } from "~/server/kernel/define";

const HISTORY_KEY = "history";

const phases = ["facts", "quality", "search", "diagnostics"] as const;

/** Manifest dependencies order each phase. Self-dependencies describe domain graphs, not scheduler work. */
export function rebuildDeclarations(): readonly EntityStoredDerivedDeclaration[] {
  const declarations = entityStoredDerivedDeclarations().filter(
    (entry) => !entry.snapshotSource?.view,
  );
  const byTarget = new Map(declarations.map((entry) => [entry.target, entry]));
  const ordered: EntityStoredDerivedDeclaration[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (entry: EntityStoredDerivedDeclaration) => {
    if (visited.has(entry.target)) return;
    if (visiting.has(entry.target))
      throw new Error(`Cyclic rebuild declarations: ${entry.target}`);
    visiting.add(entry.target);
    for (const dependency of entry.dependsOn) {
      const target = `${dependency.entity}.${dependency.key}`;
      if (target === entry.target) continue;
      const source = byTarget.get(target);
      if (source) visit(source);
    }
    visiting.delete(entry.target);
    visited.add(entry.target);
    ordered.push(entry);
  };
  for (const phase of phases)
    for (const entry of declarations)
      if ((entry.rebuildPhase ?? "facts") === phase) visit(entry);
  return ordered;
}

/** Enumerate one bounded page; the Pass owns attempts and position. */
export async function enumerateSnapshotPage(
  db: Database,
  declaration: EntityStoredDerivedDeclaration,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const result = await getDb(db).execute<{
    id: string;
  }>(sql`SELECT source.id FROM ${sql.identifier(declaration.table)} source
    JOIN "Entity" identity ON identity.id = source.id AND identity.kind = ${declaration.entity}
    WHERE ${notDeleted("identity")} ${afterId ? sql`AND source.id > ${afterId}::uuid` : sql``}
    ORDER BY source.id LIMIT ${limit}`);
  return result.rows.map((row) => row.id);
}

/** Publish each result to the typed columns its entity declares. */
export async function publishRebuiltValues(
  db: RepositoryQueryInput,
  declaration: EntityStoredDerivedDeclaration,
  ids: readonly string[],
  values: ReadonlyMap<string, DerivedComputed>,
): Promise<void> {
  const rows = ids.flatMap((id) => {
    const raw = values.get(id);
    if (!raw) return [];
    const value = validateComputedResult({
      target: declaration.target,
      computed: raw,
    });
    return [
      {
        entityId: id,
        value: value.value,
        decidedBy: computedDecision(value),
        sortNumber: declaration.sort === "number" ? value.sort : null,
        sortText: declaration.sort === "text" ? value.sort : null,
        sortDate: declaration.sort === "date" ? value.sort : null,
      },
    ];
  });
  const source = declaration.snapshotSource;
  if (source && !source.view) {
    if (typeof source.value !== "string" || !source.decidedBy || !source.sort)
      throw new Error(
        `Incomplete writable snapshot declaration: ${declaration.target}`,
      );
    const valueColumn = sql.identifier(source.value);
    const decisionColumn = sql.identifier(source.decidedBy);
    const sortColumn = sql.identifier(source.sort);
    const computedColumn = sql.identifier(source.computedAt);
    const table = sql.identifier(source.table);
    const valueSql =
      source.storage === "number"
        ? sql`(r.value #>> '{}')::double precision`
        : source.storage === "text"
          ? sql`r.value #>> '{}'`
          : sql`r.value`;
    const sortSql =
      declaration.sort === "number"
        ? sql`r."sortNumber"`
        : declaration.sort === "date"
          ? sql`r."sortDate"`
          : sql`r."sortText"`;
    await getDb(db).execute(sql`
      INSERT INTO ${table} ("entityId", kind, ${valueColumn}, ${decisionColumn}, ${sortColumn}, ${computedColumn})
      SELECT r."entityId", ${declaration.entity}, ${valueSql}, r."decidedBy", ${sortSql}, now() AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) r("entityId" uuid, value jsonb, "decidedBy" jsonb, "sortNumber" double precision, "sortText" text, "sortDate" timestamp)
      JOIN "Entity" e ON e.id = r."entityId" AND e.kind = ${declaration.entity} AND ${notDeleted("e")}
      ON CONFLICT ("entityId") DO UPDATE SET ${valueColumn} = EXCLUDED.${valueColumn}, ${decisionColumn} = EXCLUDED.${decisionColumn},
        ${sortColumn} = EXCLUDED.${sortColumn}, ${computedColumn} = EXCLUDED.${computedColumn}
      WHERE (${table}.${valueColumn}, ${table}.${decisionColumn}, ${table}.${sortColumn})
        IS DISTINCT FROM (EXCLUDED.${valueColumn}, EXCLUDED.${decisionColumn}, EXCLUDED.${sortColumn})`);
    const missing = ids.filter((id) => !values.has(id));
    if (missing.length)
      await getDb(db)
        .execute(sql`UPDATE ${table} SET ${valueColumn} = NULL, ${decisionColumn} = NULL, ${sortColumn} = NULL, ${computedColumn} = NULL
      WHERE "entityId" = ANY(${uuidArrayParam(missing)})`);
    return;
  }
  if (source?.view) return;
  throw new Error(`Missing writable snapshot: ${declaration.target}`);
}

/** Whether the singleton bulk pass is still owed. */
export async function rebuildActive(db: Database): Promise<boolean> {
  const result = await getDb(db).execute<{
    active: boolean;
  }>(sql`SELECT EXISTS (
    SELECT 1 FROM "Pass" WHERE name = ${DERIVED_SNAPSHOT_PASS} AND key = ${DERIVED_SNAPSHOT_KEY}
      AND "doneAt" IS NULL AND "cancelledAt" IS NULL) AS active`);
  return result.rows[0]?.active ?? false;
}

/** A repair joins active work; the scheduled admission starts at most one new pass per hour. */
export async function requestDerivedRebuild(
  db: Database,
  options: { force?: boolean; runId?: string } = {},
): Promise<{ existing: boolean }> {
  const existing = await rebuildActive(db);
  await getDb(db).execute(sql`INSERT INTO "Pass" (name, key, "runId", cursor)
    VALUES (${DERIVED_SNAPSHOT_PASS}, ${DERIVED_SNAPSHOT_KEY}, ${options.runId ?? null}::uuid, '{}'::jsonb)
    ON CONFLICT (name, key) DO UPDATE SET
      cursor = CASE WHEN "Pass"."doneAt" IS NOT NULL OR "Pass"."cancelledAt" IS NOT NULL THEN jsonb_build_object(
        ${HISTORY_KEY}::text, coalesce("Pass".cursor->${HISTORY_KEY}::text, '[]'::jsonb), 'durationsMs', coalesce("Pass".cursor->'durationsMs', '[]'::jsonb),
        'cleanAt', "Pass".cursor->'cleanAt', 'failures', coalesce("Pass".cursor->'failures', '0'::jsonb)) ELSE "Pass".cursor END,
      "runId" = coalesce(excluded."runId", "Pass"."runId"), "doneAt" = NULL, "cancelledAt" = NULL,
      attempts = 0, "lastError" = NULL, "availableAt" = now(), "updatedAt" = now()
    WHERE ("Pass"."doneAt" IS NULL AND "Pass"."cancelledAt" IS NULL) OR ${options.force ?? true}
      OR coalesce(("Pass".cursor->>'startedAt')::timestamp, 'epoch'::timestamp) < date_trunc('hour', now())`);
  return { existing };
}

/** Save preparation attempts under the live Pass so isolate deaths remain resumable. */
export async function recordSnapshotCursor(
  claim: Claim,
  cursor: SnapshotCursor,
): Promise<void> {
  await claim.fenced(async (tx) => {
    await getDb(tx)
      .execute(sql`UPDATE "Pass" SET cursor = ${JSON.stringify(cursor)}::jsonb
      WHERE name = ${DERIVED_SNAPSHOT_PASS} AND key = ${DERIVED_SNAPSHOT_KEY}`);
  });
}

/** Isolate failed publication and its queued effects in the page's savepoint. */
export function publishSnapshotPage(
  db: Database,
  publish: (tx: Database) => Promise<void>,
): Promise<void> {
  return repositoryTransactionDatabase(db, publish);
}

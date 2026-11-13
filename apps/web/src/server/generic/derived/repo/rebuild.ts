import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import {
  entityStoredDerivedDeclarations,
  type EntityStoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import {
  DERIVED_REBUILD_KEY,
  DERIVED_REBUILD_LEASE_SECONDS,
} from "~/server/db/derived-rebuild-schema";
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

const phases = ["facts", "quality", "search", "diagnostics"] as const;

/** Manifest dependencies order each phase. Self-dependencies describe domain graphs, not scheduler work. */
export function rebuildDeclarations(): readonly EntityStoredDerivedDeclaration[] {
  const declarations = entityStoredDerivedDeclarations().filter(
    (entry) => !entry.snapshotSource?.view && !entry.reconciler,
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

const claimRow = z.object({
  target: z.string(),
  afterId: z.uuid().nullable(),
});
export type RebuildClaim = z.infer<typeof claimRow> & { token: string };

/** Every abandoned cursor claim is durable, including isolate termination. A pass always resumes. */
export async function claimRebuild(
  db: Database,
  force = false,
): Promise<RebuildClaim | null> {
  const declarations = rebuildDeclarations();
  const first = declarations[0];
  if (!first) return null;
  const token = crypto.randomUUID();
  const restart = sql`NOT "DerivedRebuild".running`;
  const result = await getDb(db).execute(
    sql`
    INSERT INTO "DerivedRebuild" (key, running, target, "startedAt", token, "leaseExpiresAt", "cursorAttempts", "passFailures")
    VALUES (${DERIVED_REBUILD_KEY}, true, ${first.target}, now() AT TIME ZONE 'UTC', ${token}::uuid,
      (now() AT TIME ZONE 'UTC') + interval '1 second' * ${DERIVED_REBUILD_LEASE_SECONDS}, 1, 0)
    ON CONFLICT (key) DO UPDATE SET
      running = true,
      target = CASE WHEN ${restart} THEN EXCLUDED.target ELSE "DerivedRebuild".target END,
      "afterId" = CASE WHEN ${restart} THEN NULL ELSE "DerivedRebuild"."afterId" END,
      "startedAt" = CASE WHEN ${restart} THEN EXCLUDED."startedAt" ELSE "DerivedRebuild"."startedAt" END,
      "cursorAttempts" = CASE WHEN ${restart} THEN 1 ELSE "DerivedRebuild"."cursorAttempts" + 1 END,
      "passFailures" = CASE WHEN ${restart} THEN 0 ELSE "DerivedRebuild"."passFailures" END,
      pages = CASE WHEN ${restart} THEN 0 ELSE "DerivedRebuild".pages END,
      "processedRecords" = CASE WHEN ${restart} THEN 0 ELSE "DerivedRebuild"."processedRecords" END,
      "failedPages" = CASE WHEN ${restart} THEN 0 ELSE "DerivedRebuild"."failedPages" END,
      error = CASE WHEN ${restart} THEN NULL ELSE "DerivedRebuild".error END,
      token = EXCLUDED.token, "leaseExpiresAt" = EXCLUDED."leaseExpiresAt"
    WHERE ("DerivedRebuild"."leaseExpiresAt" IS NULL OR "DerivedRebuild"."leaseExpiresAt" < now() AT TIME ZONE 'UTC' OR ("DerivedRebuild".token IS NULL AND ${force}))
      AND ("DerivedRebuild".running OR ${force} OR "DerivedRebuild"."startedAt" IS NULL OR "DerivedRebuild"."startedAt" < date_trunc('hour', now() AT TIME ZONE 'UTC'))
    RETURNING target, "afterId"`,
    "objects",
  );
  const row = z.array(claimRow).parse(result)[0];
  return row ? { ...row, token } : null;
}

/** `claimRebuild`'s eligibility: a lapsed or absent lease on a running pass, or a new hour. */
const rebuildClaimable = sql`(r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt" < now() AT TIME ZONE 'UTC')
  AND (r.running OR r."startedAt" IS NULL OR r."startedAt" < date_trunc('hour', now() AT TIME ZONE 'UTC'))`;

/** Permit selection: the pass can take a page now. */
export const derivedRebuildDue = (unit: string) =>
  sql`SELECT ${unit}::text AS unit, false AS demand,
      coalesce(r."leaseExpiresAt", r."startedAt", now() AT TIME ZONE 'UTC') AS since
    FROM (SELECT 1) one LEFT JOIN "DerivedRebuild" r ON r.key = ${DERIVED_REBUILD_KEY}
    WHERE r.key IS NULL OR (${rebuildClaimable})`;

/** When the pass can next take a page: its lease lapsing, or the next hour's pass. */
export const derivedRebuildNext = () =>
  sql`SELECT CASE
      WHEN r.key IS NULL THEN now() AT TIME ZONE 'UTC'
      WHEN r.running THEN coalesce(r."leaseExpiresAt", now() AT TIME ZONE 'UTC')
      WHEN r."startedAt" IS NULL OR r."startedAt" < date_trunc('hour', now() AT TIME ZONE 'UTC')
        THEN coalesce(r."leaseExpiresAt", now() AT TIME ZONE 'UTC')
      ELSE date_trunc('hour', now() AT TIME ZONE 'UTC') + interval '1 hour'
    END
    FROM (SELECT 1) one LEFT JOIN "DerivedRebuild" r ON r.key = ${DERIVED_REBUILD_KEY}`;

/** Record an attempt and enumerate its bounded population in one committed statement. */
export async function beginRebuildPage(
  db: Database,
  token: string,
  declaration: EntityStoredDerivedDeclaration,
  afterId: string | null,
  configured: number,
  first: boolean,
): Promise<{ ids: string[]; attempts: number; limit: number } | null> {
  const result = await getDb(db).execute(
    sql`
    WITH attempt AS (
      UPDATE "DerivedRebuild" SET "cursorAttempts" = "cursorAttempts" + ${first ? 0 : 1}
      WHERE key = ${DERIVED_REBUILD_KEY} AND token = ${token}::uuid
      RETURNING "cursorAttempts" AS attempts
    ), page AS (
      SELECT source.id FROM ${sql.identifier(declaration.table)} AS source
      JOIN "Entity" identity ON identity.id = source.id AND identity.kind = ${declaration.entity}
      WHERE ${notDeleted("identity")} ${afterId ? sql`AND source.id > ${afterId}::uuid` : sql``}
      ORDER BY source.id LIMIT (SELECT greatest(1, floor(${configured} / power(2, floor((attempts - 1) / 3.0))))::int FROM attempt)
    ) SELECT attempts, greatest(1, floor(${configured} / power(2, floor((attempts - 1) / 3.0))))::int AS limit,
      coalesce((SELECT jsonb_agg(id ORDER BY id) FROM page), '[]'::jsonb) AS ids FROM attempt`,
    "objects",
  );
  return (
    z
      .array(
        z.object({
          attempts: z.number().int(),
          limit: z.number().int(),
          ids: z.array(z.uuid()),
        }),
      )
      .parse(result)[0] ?? null
  );
}

/** Only the coarse pass cursor is locked. Source writes need no fence or generation. */
export async function commitRebuildPage(
  db: Database,
  claim: RebuildClaim,
  next: { target: string; afterId: string | null } | null,
  publish: (tx: Database) => Promise<void>,
  problem?: string,
  processedRecords = 0,
): Promise<boolean> {
  return repositoryTransactionDatabase(db, async (tx) => {
    const held = await getDb(tx).execute(
      sql`SELECT token FROM "DerivedRebuild" WHERE key = ${DERIVED_REBUILD_KEY} AND token = ${claim.token}::uuid FOR UPDATE`,
      "objects",
    );
    if (!held.length) return false;
    await publish(tx);
    await getDb(tx).execute(sql`
      UPDATE "DerivedRebuild" SET
        pages = pages + 1,
        "processedRecords" = "processedRecords" + ${processedRecords},
        "failedPages" = "failedPages" + ${problem ? 1 : 0},
        failures = CASE WHEN ${next === null} AND "passFailures" = 0 AND NOT ${!!problem} THEN 0 ELSE failures + ${problem ? 1 : 0} END,
        "passFailures" = "passFailures" + ${problem ? 1 : 0},
        error = CASE WHEN ${!!problem} THEN ${problem ?? null} || coalesce(${": "} || error, '') WHEN ${next === null} AND "passFailures" = 0 THEN NULL ELSE error END,
        "lastMovementAt" = now() AT TIME ZONE 'UTC',
        "cleanAt" = CASE WHEN ${next === null} AND "passFailures" = 0 AND NOT ${!!problem} THEN now() AT TIME ZONE 'UTC' ELSE "cleanAt" END,
        running = ${next !== null}, target = ${next?.target ?? null}, "afterId" = ${next?.afterId ?? null}::uuid,
        "cursorAttempts" = 0,
        token = CASE WHEN ${next === null} THEN NULL ELSE token END,
        "leaseExpiresAt" = CASE WHEN ${next === null} THEN NULL ELSE (now() AT TIME ZONE 'UTC') + interval '1 second' * ${DERIVED_REBUILD_LEASE_SECONDS} END,
        "finishedAt" = CASE WHEN ${next === null} THEN now() AT TIME ZONE 'UTC' ELSE "finishedAt" END,
        "durationsMs" = CASE WHEN ${next === null} THEN ("durationsMs" || ARRAY[extract(epoch FROM ((now() AT TIME ZONE 'UTC') - "startedAt"))::double precision * 1000])[greatest(cardinality("durationsMs") - 1, 1):] ELSE "durationsMs" END,
        history = CASE WHEN ${next === null} THEN
          (SELECT coalesce(jsonb_agg(entry ORDER BY ordinal), '[]'::jsonb) FROM jsonb_array_elements(history || jsonb_build_array(jsonb_build_object(
            'startedAt', "startedAt", 'finishedAt', now() AT TIME ZONE 'UTC',
            'durationMs', extract(epoch FROM ((now() AT TIME ZONE 'UTC') - "startedAt"))::double precision * 1000,
            'pages', pages + 1, 'processedRecords', "processedRecords" + ${processedRecords}, 'failedPages', "failedPages" + ${problem ? 1 : 0}
          ))) WITH ORDINALITY AS recent(entry, ordinal) WHERE ordinal > jsonb_array_length(history) - 2)
          ELSE history END
      WHERE key = ${DERIVED_REBUILD_KEY}`);
    return true;
  });
}

export async function releaseRebuild(
  db: Database,
  token: string,
  error: string | null = null,
  options?: { readonly countFailure?: boolean },
): Promise<void> {
  // A transient drop passes the error with countFailure false: the attempt
  // streak and the error stay, and failures do not move. A clean release
  // (no error) still resets the streak. A real release error counts.
  const countFailure = (options?.countFailure ?? error !== null) ? 1 : 0;
  await getDb(db)
    .execute(sql`UPDATE "DerivedRebuild" SET token = NULL, "leaseExpiresAt" = NULL,
    "cursorAttempts" = CASE WHEN ${error}::text IS NULL THEN 0 ELSE "cursorAttempts" END,
    failures = failures + ${countFailure},
    "passFailures" = "passFailures" + ${countFailure},
    error = coalesce(${error}::text, error)
    WHERE key = ${DERIVED_REBUILD_KEY} AND token = ${token}::uuid`);
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

/** A duplicate delivery must retry after the coarse lease, including an isolate killed mid-page. */
export async function rebuildActive(db: Database): Promise<boolean> {
  const result = await getDb(db).execute(
    sql`SELECT 1 FROM "DerivedRebuild" WHERE key = ${DERIVED_REBUILD_KEY} AND running`,
    "objects",
  );
  return result.length > 0;
}

/** A member repair joins active work instead of creating per-value tickets. */
export async function requestDerivedRebuild(
  db: Database,
): Promise<{ existing: boolean }> {
  const existing = await rebuildActive(db);
  if (existing) return { existing: true };
  const claim = await claimRebuild(db, true);
  if (claim) await releaseRebuild(db, claim.token);
  return { existing: existing || claim === null };
}

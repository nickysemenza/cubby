import { derivedRebuildStatusSchema } from "@cubby/schemas/maintenance";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import {
  entityStoredDerivedDeclarations,
  type EntityStoredDerivedDeclaration,
} from "~/server/db/derived-declarations";
import { derivedRebuild } from "~/server/db/derived-rebuild-schema";
import {
  DERIVED_REBUILD_KEY,
  DERIVED_REBUILD_LEASE_SECONDS,
} from "~/server/db/derived-rebuild-schema";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import {
  computedDecision,
  validateComputedResult,
  type DerivedComputed,
} from "~/server/generic/derived/repo/compute";

const phases = ["facts", "quality", "search", "diagnostics"] as const;

/** Manifest dependencies order each phase. Self-dependencies describe domain graphs, not scheduler work. */
export function rebuildDeclarations(): readonly EntityStoredDerivedDeclaration[] {
  const declarations = entityStoredDerivedDeclarations();
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

const claimRow = z.object({ target: z.string(), afterId: z.uuid().nullable() });
export type RebuildClaim = z.infer<typeof claimRow> & { token: string };

/** Expired invocations resume their committed cursor; a failed older hourly cycle starts afresh. */
export async function claimRebuild(
  db: Database,
  force = false,
): Promise<RebuildClaim | null> {
  const declarations = rebuildDeclarations();
  const first = declarations[0];
  if (!first) return null;
  const token = crypto.randomUUID();
  // A failed late phase may need output for newly inserted upstream rows. The
  // next hourly cycle starts over; transient retries within a cycle resume.
  const restart = sql`(NOT "DerivedRebuild".running OR
    ("DerivedRebuild".failures > 0 AND "DerivedRebuild"."startedAt" < date_trunc('hour', now() AT TIME ZONE 'UTC')))`;
  const result = await getDb(db).execute(sql`
    INSERT INTO "DerivedRebuild" (key, running, target, "startedAt", token, "leaseExpiresAt")
    VALUES (${DERIVED_REBUILD_KEY}, true, ${first.target}, now() AT TIME ZONE 'UTC', ${token}::uuid,
      (now() AT TIME ZONE 'UTC') + interval '1 second' * ${DERIVED_REBUILD_LEASE_SECONDS})
    ON CONFLICT (key) DO UPDATE SET
      running = true,
      target = CASE WHEN ${restart} THEN EXCLUDED.target ELSE "DerivedRebuild".target END,
      "afterId" = CASE WHEN ${restart} THEN NULL ELSE "DerivedRebuild"."afterId" END,
      "startedAt" = CASE WHEN ${restart} THEN EXCLUDED."startedAt" ELSE "DerivedRebuild"."startedAt" END,
      token = EXCLUDED.token, "leaseExpiresAt" = EXCLUDED."leaseExpiresAt"
    WHERE ("DerivedRebuild"."leaseExpiresAt" IS NULL OR "DerivedRebuild"."leaseExpiresAt" < now() AT TIME ZONE 'UTC')
      AND ("DerivedRebuild".running OR ${force} OR "DerivedRebuild"."startedAt" IS NULL OR "DerivedRebuild"."startedAt" < date_trunc('hour', now() AT TIME ZONE 'UTC'))
    RETURNING target, "afterId"`);
  const row = z.array(claimRow).parse(result.rows)[0];
  return row ? { ...row, token } : null;
}

export async function rebuildIds(
  db: Database,
  declaration: EntityStoredDerivedDeclaration,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const result = await getDb(db).execute(sql`
    SELECT source.id FROM ${sql.identifier(declaration.table)} AS source
    JOIN "Entity" identity ON identity.id = source.id AND identity.kind = ${declaration.entity}
    WHERE ${notDeleted("identity")} ${afterId ? sql`AND source.id > ${afterId}::uuid` : sql``}
    ORDER BY source.id LIMIT ${limit}`);
  return z
    .array(z.object({ id: z.uuid() }))
    .parse(result.rows)
    .map((row) => row.id);
}

/** Only the coarse pass cursor is locked. Source writes need no fence or generation. */
export async function commitRebuildPage(
  db: Database,
  claim: RebuildClaim,
  next: { target: string; afterId: string | null } | null,
  publish: (tx: Database) => Promise<void>,
): Promise<boolean> {
  return repositoryTransactionDatabase(db, async (tx) => {
    const held = await getDb(tx).execute(
      sql`SELECT token FROM "DerivedRebuild" WHERE key = ${DERIVED_REBUILD_KEY} AND token = ${claim.token}::uuid FOR UPDATE`,
    );
    if (!held.rows.length) return false;
    await publish(tx);
    if (next) {
      await getDb(tx)
        .execute(sql`UPDATE "DerivedRebuild" SET target = ${next.target}, "afterId" = ${next.afterId}::uuid,
        "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') + interval '1 second' * ${DERIVED_REBUILD_LEASE_SECONDS}
        WHERE key = ${DERIVED_REBUILD_KEY}`);
    } else {
      await getDb(tx)
        .execute(sql`UPDATE "DerivedRebuild" SET running = false, target = NULL, "afterId" = NULL,
        token = NULL, "leaseExpiresAt" = NULL, failures = 0, error = NULL,
        "finishedAt" = now() AT TIME ZONE 'UTC',
        "durationsMs" = ("durationsMs" || ARRAY[extract(epoch FROM ((now() AT TIME ZONE 'UTC') - "startedAt"))::double precision * 1000])[greatest(cardinality("durationsMs") - 1, 1):]
        WHERE key = ${DERIVED_REBUILD_KEY}`);
    }
    return true;
  });
}

export async function releaseRebuild(
  db: Database,
  token: string,
  error: string | null = null,
): Promise<void> {
  await getDb(db)
    .execute(sql`UPDATE "DerivedRebuild" SET token = NULL, "leaseExpiresAt" = NULL,
    failures = CASE WHEN ${error}::text IS NULL THEN failures ELSE failures + 1 END,
    error = coalesce(${error}::text, error)
    WHERE key = ${DERIVED_REBUILD_KEY} AND token = ${token}::uuid`);
}

/** Transitional publication for kinds whose typed snapshot cutover has not shipped yet. */
export async function publishRebuiltValues(
  db: Database,
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
  await getDb(db).execute(sql`
    INSERT INTO "DerivedValue" ("entityId", kind, key, value, "decidedBy", "sortNumber", "sortText", "sortDate", "computedAt")
    SELECT r."entityId", ${declaration.entity}, ${declaration.key}, r.value, r."decidedBy", r."sortNumber", r."sortText", r."sortDate", now() AT TIME ZONE 'UTC'
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) r("entityId" uuid, value jsonb, "decidedBy" jsonb, "sortNumber" double precision, "sortText" text, "sortDate" timestamp)
    JOIN "Entity" e ON e.id = r."entityId" AND e.kind = ${declaration.entity} AND ${notDeleted("e")}
    ON CONFLICT ("entityId", key) DO UPDATE SET value = EXCLUDED.value, "decidedBy" = EXCLUDED."decidedBy",
      "sortNumber" = EXCLUDED."sortNumber", "sortText" = EXCLUDED."sortText", "sortDate" = EXCLUDED."sortDate", "computedAt" = EXCLUDED."computedAt"
    WHERE ("DerivedValue".value, "DerivedValue"."decidedBy", "DerivedValue"."sortNumber", "DerivedValue"."sortText", "DerivedValue"."sortDate")
      IS DISTINCT FROM (EXCLUDED.value, EXCLUDED."decidedBy", EXCLUDED."sortNumber", EXCLUDED."sortText", EXCLUDED."sortDate")`);
  const missing = ids.filter((id) => !values.has(id));
  if (missing.length)
    await getDb(db).execute(
      sql`DELETE FROM "DerivedValue" WHERE key = ${declaration.key} AND "entityId" = ANY(${uuidArrayParam(missing)})`,
    );
}

/** A duplicate delivery must retry after the coarse lease, including an isolate killed mid-page. */
export async function rebuildActive(db: Database): Promise<boolean> {
  const result = await getDb(db).execute(
    sql`SELECT 1 FROM "DerivedRebuild" WHERE key = ${DERIVED_REBUILD_KEY} AND running`,
  );
  return result.rows.length > 0;
}

export async function readDerivedRebuildStatus(
  db: Database,
): Promise<z.infer<typeof derivedRebuildStatusSchema>> {
  const [row] = await getDb(db).select().from(derivedRebuild);
  return {
    running: row?.running ?? false,
    target: row?.target ?? null,
    startedAt: row?.startedAt?.toISOString() ?? null,
    finishedAt: row?.finishedAt?.toISOString() ?? null,
    failures: row?.failures ?? 0,
    error: row?.error ?? null,
    durationsMs: row?.durationsMs ?? [],
  };
}

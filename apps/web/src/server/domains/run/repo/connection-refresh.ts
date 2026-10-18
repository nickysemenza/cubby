import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import type { RunId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { entityIdentity, run, aiEvaluation } from "~/server/db/schema";
import { connectionRecord } from "~/server/domains/connection/repo/connection-evidence";
import {
  connectionDiscoveryFingerprint,
  connectionDiscoveryFingerprints,
} from "~/server/domains/connection/repo/discovery-fingerprint";
import { refreshSearchDocuments } from "~/server/generic/search/repo/search-document";

import {
  insertEvaluationTargets,
  scheduleEvaluationRun,
} from "./ai-refresh-state";
import { ensureRun, systemActor } from "./ensure-run";

const discoveryEntities = [
  "product",
  "purchase",
  "expense",
  "project",
  "task",
  "cookbook",
  "device",
  "inventory",
  "email",
  "financialTransaction",
  "ingredient",
  "plant",
  "location",
] as const;
const discoveryEntitySet = new Set<string>(discoveryEntities);

export async function scheduleConnectionRefresh(
  db: Database,
  source: EntityRef,
  actor: Parameters<typeof scheduleEvaluationRun>[1] = systemActor(),
) {
  if (!discoveryEntitySet.has(source.entityKind)) return null;
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled || !activation.manifest["entity-connections"])
    return null;
  const record = await connectionRecord(db, source);
  // The initial cursor pass also carries the expanded notes projection into
  // existing rows; fallback retrieval remains useful until that pass reaches them.
  if (source.entityKind === "purchase" || source.entityKind === "expense")
    await refreshSearchDocuments(db, [
      { entityKind: source.entityKind, entityId: record.id },
    ]);
  const provenance = aiProvenance.parse({
    dependencies: dependencyStamps(activation.manifest, ["entity-connections"]),
    inputFingerprint: await connectionSourceFingerprint(db, source),
    optionFingerprint: "typed-connection-discovery-v1",
    model: null,
  });
  const target = aiEvaluationTarget.parse({
    kind: "connection",
    entity: source.entityKind,
    recordId: record.id,
    field: null,
    assessmentIds: [],
  });
  const key = await sha256Hex(JSON.stringify([target, provenance]));
  const scheduled = await scheduleEvaluationRun(
    db,
    actor,
    {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
      clientKey: `ai-refresh:connection:${key}`,
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    },
    [{ target, provenance, snapshot: source }],
  );
  if (scheduled) return scheduled;
  const [existing] = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .innerJoin(aiEvaluation, eq(aiEvaluation.runId, run.id))
    .where(
      and(
        eq(run.clientKey, `ai-refresh:connection:${key}`),
        ne(run.status, "completed"),
        ne(aiEvaluation.state, "completed"),
        notDeleted(run),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

/** The kinds a connection Sweep can cover. */
export const connectionSweepEntities: readonly string[] = discoveryEntities;

/**
 * The child `ai_refresh` Run that evaluates one Sweep's connection sources.
 * It is created `running` at attempt 0 and launched once its roster is ready.
 */
export async function ensureConnectionSweepRun(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  parentRunId: RunId,
) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled || !activation.manifest["entity-connections"])
    return null;
  return ensureRun(db, actor, {
    purpose: "ai_refresh",
    trigger: "manual",
    status: "running",
    clientKey: `sweep:${parentRunId}:recommendation`,
    parentRunId,
    input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
  });
}

/**
 * One roster page of a connection Sweep: eligible sources after the cursor,
 * each queued on the child Run unless its current fingerprint was already
 * evaluated (or is being evaluated) under any Run.
 */
export async function prepareConnectionSweepPage(
  db: Database,
  input: {
    childRunId: RunId;
    after: string | null;
    limit: number;
    entityKinds?: readonly string[];
  },
) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled || !activation.manifest["entity-connections"])
    throw new Error(
      "Connection discovery requires an active AI refresh generation",
    );
  const page = await connectionDiscoveryRecords(
    db,
    input.after,
    input.limit,
    input.entityKinds,
  );
  const sources = page.map((record) => record.source);
  const fingerprints = await connectionSourceFingerprints(db, sources);
  const inserted = await insertEvaluationTargets(
    db,
    input.childRunId,
    page.map((record, index) => ({
      target: aiEvaluationTarget.parse({
        kind: "connection",
        entity: record.source.entityKind,
        recordId: record.id,
        field: null,
        assessmentIds: [],
      }),
      provenance: aiProvenance.parse({
        dependencies: dependencyStamps(activation.manifest, [
          "entity-connections",
        ]),
        inputFingerprint: fingerprints[index],
        optionFingerprint: "typed-connection-discovery-v1",
        model: null,
      }),
      snapshot: record.source,
    })),
  );
  return {
    scanned: page.length,
    inserted,
    next: page.length === input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** How many sources a connection Sweep's scope covers. */
export async function countConnectionSweepSources(
  db: Database,
  entityKinds?: readonly string[],
) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(entityIdentity)
    .where(
      and(
        isNull(entityIdentity.deletedAt),
        isNull(entityIdentity.mergedIntoId),
        inArray(entityIdentity.kind, sweepKinds(entityKinds)),
      ),
    );
  return row?.count ?? 0;
}

const sweepKinds = (entityKinds?: readonly string[]) =>
  entityKinds?.length
    ? discoveryEntities.filter((kind) => entityKinds.includes(kind))
    : [...discoveryEntities];

export const connectionSourceFingerprint = connectionDiscoveryFingerprint;
export const connectionSourceFingerprints = connectionDiscoveryFingerprints;

/** Cursor coverage includes records without stock or prior acquisition. */
export async function connectionDiscoveryRecords(
  db: Database,
  after: string | null,
  limit: number,
  entityKinds?: readonly string[],
) {
  const rows = await getDb(db)
    .select({
      id: entityIdentity.id,
      entity: entityIdentity.kind,
      shortcode: entityIdentity.shortcode,
    })
    .from(entityIdentity)
    .where(
      and(
        isNull(entityIdentity.deletedAt),
        isNull(entityIdentity.mergedIntoId),
        inArray(entityIdentity.kind, sweepKinds(entityKinds)),
        after ? gt(entityIdentity.id, after) : undefined,
      ),
    )
    .orderBy(asc(entityIdentity.id))
    .limit(limit);
  return rows.flatMap((row) =>
    row.shortcode
      ? [
          {
            id: row.id,
            source: {
              entityKind: entitySchema.parse(row.entity),
              entityId: row.shortcode,
            },
          },
        ]
      : [],
  );
}

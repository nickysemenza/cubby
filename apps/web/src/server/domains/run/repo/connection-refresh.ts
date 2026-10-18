import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { entityIdentity, run, aiEvaluation } from "~/server/db/schema";
import { connectionRecord } from "~/server/domains/connection/repo/connection-evidence";
import { connectionDiscoveryFingerprint } from "~/server/domains/connection/repo/discovery-fingerprint";
import { refreshSearchDocuments } from "~/server/generic/search/repo/search-document";

import { scheduleEvaluationRun } from "./ai-refresh-state";
import { systemActor } from "./ensure-run";

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

export const connectionSourceFingerprint = connectionDiscoveryFingerprint;

/** Cursor coverage includes records without stock or prior acquisition. */
export async function connectionDiscoveryRecords(
  db: Database,
  after: string | null,
  limit: number,
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
        inArray(entityIdentity.kind, [...discoveryEntities]),
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

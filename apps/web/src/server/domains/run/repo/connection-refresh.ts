import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import { searchableEntities } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  entityIdentity,
  searchDocument,
  orderMail,
  orderMailEvent,
  assessmentEmailLink,
  importSourceOrder,
  run,
  aiEvaluation,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { connectionRecord } from "~/server/domains/connection/repo/connection-evidence";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
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
    systemActor(),
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

export async function connectionSourceFingerprint(
  db: Database,
  source: EntityRef,
) {
  const record = await connectionRecord(db, source);
  // A new or changed potential endpoint must invalidate a completed negative scan.
  // Content hashes avoid rescheduling merely because projections were rebuilt.
  const [roster] = await getDb(db)
    .select({
      fingerprint: sql<string>`md5(coalesce(string_agg(${searchDocument.entityId}::text || ':' || ${searchDocument.sourceHash}, ',' ORDER BY ${searchDocument.entityId}), ''))`,
    })
    .from(searchDocument)
    .where(
      and(
        notDeleted(searchDocument),
        inArray(
          searchDocument.entityKind,
          searchableEntities.filter((entity) => discoveryEntitySet.has(entity)),
        ),
      ),
    );
  const [identities] = await getDb(db)
    .select({
      fingerprint: sql<string>`md5(coalesce(string_agg(id::text || ':' || coalesce("deletedAt"::text, '') || ':' || coalesce("mergedIntoId"::text, ''), ',' ORDER BY id), ''))`,
    })
    .from(entityIdentity)
    .where(inArray(entityIdentity.kind, [...discoveryEntities]));
  const [mail] = await getDb(db)
    .select({
      fingerprint: sql<string>`md5(jsonb_build_array(
    (SELECT coalesce(jsonb_agg(jsonb_build_array(o.id, o."ledgerPartyId", o."vendorId", o."rawChecksum") ORDER BY o.id), '[]'::jsonb) FROM ${orderMail} o),
    (SELECT coalesce(jsonb_agg(jsonb_build_array(e.id, e."orderMailId", e.event, e."orderId", e.amount, e."sourceKey", e."supersededAt") ORDER BY e.id), '[]'::jsonb) FROM ${orderMailEvent} e),
    (SELECT coalesce(jsonb_agg(jsonb_build_array(l.id, l."eventId", l."purchaseId", l.decision, l."evidenceChecksum") ORDER BY l.id), '[]'::jsonb) FROM ${assessmentEmailLink} l),
    (SELECT coalesce(jsonb_agg(jsonb_build_array(a.id, a."sourceClaimId", a."purchaseId", a.checksum) ORDER BY a.id), '[]'::jsonb) FROM ${importSourceOrder} a),
    (SELECT coalesce(jsonb_agg(jsonb_build_array(p.id, p."vendorAccountId", p."orderId", p."vendorId", p.date, p."statedTotal", p."deletedAt") ORDER BY p.id), '[]'::jsonb) FROM ${purchase} p),
    (SELECT coalesce(jsonb_agg(jsonb_build_array(a.id, a."vendorId", a."ledgerPartyId", a."deletedAt") ORDER BY a.id), '[]'::jsonb) FROM ${vendorAccount} a)
  )::text)`,
    })
    .from(sql`(SELECT 1) AS connection_mail_roster`);
  return sha256Hex(
    canonicalJson({
      source: record.row,
      roster: roster?.fingerprint ?? null,
      identities: identities?.fingerprint ?? null,
      mail: mail?.fingerprint ?? null,
    }),
  );
}

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

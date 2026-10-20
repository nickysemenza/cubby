import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import type { RunId } from "@cubby/schemas/identifiers";
import { MAX_AUTOMATIC_WORKFLOW_FAILURES } from "@cubby/schemas/workflow-runs";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { PENDING_AI_STATES } from "~/server/ai/repo/ai-evaluation-requests";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { entityIdentity, run, aiEvaluation } from "~/server/db/schema";
import { connectionRecord } from "~/server/domains/connection/repo/connection-evidence";
import {
  connectionDiscoveryFingerprint,
  connectionDiscoveryFingerprints,
} from "~/server/domains/connection/repo/discovery-fingerprint";
import { connectionInputKeys } from "~/server/domains/connection/repo/discovery-inputs";
import { hasUnmaterializedInputs } from "~/server/generic/derived-refresh/repo/freshness";

import {
  hasAiRefreshRunCapacity,
  tryLockAiRefreshScheduling,
} from "./ai-refresh-admission";
import {
  insertEvaluationTargets,
  scheduleEvaluationRun,
} from "./ai-refresh-state";
import { ensureRun, systemActor } from "./ensure-run";

export class ConnectionAdmissionDeferred extends Error {}

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

type ConnectionRefreshResult =
  | { kind: "scheduled"; runId: RunId }
  | { kind: "recoverable"; runId: RunId }
  | { kind: "unchanged"; runId: RunId | null }
  | (Extract<
      Awaited<ReturnType<typeof scheduleEvaluationRun>>,
      { kind: "deferred" }
    > & { runId: null })
  | { kind: "stopped"; runId: RunId; diagnostic: string };

export async function scheduleConnectionRefresh(
  db: Database,
  source: EntityRef,
  actor: Parameters<typeof scheduleEvaluationRun>[1] = systemActor(),
): Promise<ConnectionRefreshResult> {
  if (!discoveryEntitySet.has(source.entityKind))
    return { kind: "unchanged", runId: null };
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled || !activation.manifest["entity-connections"])
    return { kind: "unchanged", runId: null };
  const record = await connectionRecord(db, source);
  const provenance = aiProvenance.parse({
    dependencies: dependencyStamps(activation.manifest, ["entity-connections"]),
    inputFingerprint: await connectionSourceFingerprint(db, source),
    optionFingerprint: "typed-connection-discovery-v2",
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
  if (scheduled.kind === "scheduled") return scheduled;
  if (scheduled.kind === "deferred") return { ...scheduled, runId: null };
  const [existing] = await getDb(db)
    .select({
      id: run.id,
      shortcode: run.shortcode,
      status: run.status,
      failureCode: run.failureCode,
      dispatchError: run.dispatchError,
      state: aiEvaluation.state,
      failures: sql<number>`coalesce((${run.progress}->>'automaticRecoveryFailures')::int, 0)`,
    })
    .from(run)
    .innerJoin(aiEvaluation, eq(aiEvaluation.runId, run.id))
    .where(
      and(
        eq(aiEvaluation.target, target),
        eq(aiEvaluation.provenance, provenance),
        sql`${aiEvaluation.receipt}->>'retryEvaluationId' IS NULL`,
        notDeleted(run),
      ),
    )
    .limit(1);
  if (!existing || existing.state === "completed")
    return { kind: "unchanged", runId: null };
  if (
    existing.failureCode !== "user_cancelled" &&
    PENDING_AI_STATES.includes(existing.state) &&
    (existing.status === "running" ||
      ((existing.status === "failed" ||
        existing.status === "dispatch_failed") &&
        existing.failures < MAX_AUTOMATIC_WORKFLOW_FAILURES))
  )
    return {
      kind: existing.status === "running" ? "unchanged" : "recoverable",
      runId: existing.id,
    };
  return {
    kind: "stopped",
    runId: existing.id,
    diagnostic: `Connection refresh ${existing.shortcode}: status=${existing.status}, failureCode=${existing.failureCode ?? "none"}, evaluation=${existing.state}, automaticRecoveryFailures=${existing.failures}.\n${existing.dispatchError ?? ""}`,
  };
}

/**
 * The child `ai_refresh` Run that evaluates one Sweep's connection sources.
 * It is created `running` at attempt 0 and launched once its roster is ready.
 */
export async function ensureConnectionSweepRun(
  db: Database,
  actor: Parameters<typeof ensureRun>[1],
  parentRunId: RunId,
  /** The parent's: a scheduled Sweep's child is background work. */
  trigger: "scheduled" | "manual",
) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled || !activation.manifest["entity-connections"])
    return null;
  return withTransactionDatabase(db, async (tx) => {
    const [existing] = await getDb(tx)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.clientKey, `sweep:${parentRunId}:recommendation`))
      .limit(1);
    if (existing) return existing.id;
    if (
      trigger === "scheduled" &&
      (!(await tryLockAiRefreshScheduling(tx)) ||
        !(await hasAiRefreshRunCapacity(tx)))
    )
      throw new ConnectionAdmissionDeferred(
        "Connection discovery waits for AI capacity",
      );
    return ensureRun(tx, actor, {
      purpose: "ai_refresh",
      trigger,
      status: "running",
      clientKey: `sweep:${parentRunId}:recommendation`,
      parentRunId,
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    });
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
  for (const kind of new Set(page.map((record) => record.source.entityKind))) {
    const kinds = [
      kind,
      ...connectionInputKeys(kind)
        .filter((key) => key.startsWith("kind:"))
        .map((key) => key.slice(5)),
    ];
    if (
      await hasUnmaterializedInputs(db, kinds, {
        includePublishing: true,
        pendingOnly: true,
      })
    )
      throw new ConnectionAdmissionDeferred(
        `Connection discovery waits for derived inputs: ${kind}`,
      );
  }
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
        optionFingerprint: "typed-connection-discovery-v2",
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
async function connectionDiscoveryRecords(
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

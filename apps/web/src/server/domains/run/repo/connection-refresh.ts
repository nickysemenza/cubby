import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import type { RunId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { PENDING_AI_STATES } from "~/server/ai/repo/ai-evaluation-requests";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { entityIdentity, job, run, aiEvaluation } from "~/server/db/schema";
import { connectionRecord } from "~/server/domains/connection/repo/connection-evidence";
import {
  connectionDiscoveryFingerprint,
  connectionDiscoveryFingerprints,
  connectionDiscoveryFingerprintsOrMissing,
} from "~/server/domains/connection/repo/discovery-fingerprint";

import {
  hasAdmissibleTarget,
  insertEvaluationTargets,
  scheduleEvaluationRun,
} from "./ai-refresh-state";
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
    existing.status === "running"
  )
    return { kind: "unchanged", runId: existing.id };
  return {
    kind: "stopped",
    runId: existing.id,
    diagnostic: `Connection refresh ${existing.shortcode}: status=${existing.status}, failureCode=${existing.failureCode ?? "none"}, evaluation=${existing.state}.\n${existing.dispatchError ?? ""}`,
  };
}

type RosterInput = {
  after: string | null;
  limit: number;
  /**
   * Routine discovery walks newest records first so current data is evaluated
   * before a backfill reaches old rows; `after` is then a `createdAt|id` cursor.
   */
  newestFirst?: boolean;
  entityKinds?: readonly string[];
  /** The population cutoff a Sweep step froze with its count. */
  createdBefore?: Date | null;
};

/** One roster page's eligible sources as evaluation targets under the current activation. */
async function connectionRosterTargets(db: Database, input: RosterInput) {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled || !activation.manifest["entity-connections"])
    throw new Error(
      "Connection discovery requires an active AI refresh generation",
    );
  const page = await connectionDiscoveryRecords(db, input);
  const fingerprints = await connectionSourceFingerprints(
    db,
    page.map((record) => record.source),
  );
  return {
    targets: page.map((record, index) => ({
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
    scanned: page.length,
    next: page.length === input.limit ? (page.at(-1)?.cursor ?? null) : null,
  };
}

/**
 * One roster page of connection evaluation: eligible sources after the
 * cursor, each queued as an evaluation the Run owns unless its current
 * fingerprint was already evaluated (or is being evaluated) under any Run.
 */
export async function prepareConnectionSweepPage(
  db: Database,
  input: RosterInput & { runId: RunId },
) {
  const page = await connectionRosterTargets(db, input);
  const inserted = await insertEvaluationTargets(db, input.runId, page.targets);
  return { scanned: page.scanned, inserted, next: page.next };
}

/**
 * A routine discovery page: its Run is created only by the first page with
 * admissible work, in the same transaction as that work.
 */
export async function prepareConnectionDiscoveryRoster(
  db: Database,
  input: RosterInput & {
    runId: RunId | null;
    /** A stopped Run this pass continues from, until a continuation opens. */
    replacing?: RunId | null;
    /**
     * Opens the pass's Run. `replacing` names a stopped Run the cursor carried,
     * so the continuation gets its own idempotency key instead of resolving
     * back to the stopped Run.
     */
    createRun: (tx: Database, replacing: RunId | null) => Promise<RunId>;
  },
) {
  return withTransactionDatabase(db, async (db) => {
    const ownerIds = [
      ...new Set([input.runId, input.replacing].filter((id) => id != null)),
    ];
    const owners = ownerIds.length
      ? await getDb(db)
          .select({ id: run.id, failureCode: run.failureCode })
          .from(run)
          .where(inArray(run.id, ownerIds))
          .orderBy(run.id)
          .for("update")
      : [];
    const stoppedByMember = () => ({
      outcome: "member-stopped" as const,
      scanned: 0,
      inserted: 0,
      next: input.after,
      runId: null,
      replacing: input.runId ?? input.replacing ?? null,
    });
    if (owners.some((owner) => owner.failureCode === "user_cancelled"))
      return stoppedByMember();
    const page = await connectionRosterTargets(db, input);
    // A cancelled or failed Run in the cursor never receives more work.
    const current = input.runId && (await runIsActive(db, input.runId));
    // Keep the stopped owner's identity across pages that admit nothing, or a
    // later page would reopen the original key and resolve the stopped Run.
    let stopped = current ? null : (input.runId ?? input.replacing ?? null);
    let runId = current ? input.runId : null;
    if (!runId && (await hasAdmissibleTarget(db, page.targets)))
      // An idempotent open can return a Run stopped since it was created, also
      // one the cursor never saved; continue after it under its next key.
      for (let open = 0; open < 3 && !runId; open++) {
        const opened = await input.createRun(db, stopped);
        const [owner] = await getDb(db)
          .select({ failureCode: run.failureCode })
          .from(run)
          .where(eq(run.id, opened))
          .for("update");
        if (owner?.failureCode === "user_cancelled") return stoppedByMember();
        if (await runIsActive(db, opened)) runId = opened;
        else if (opened === stopped) break;
        else stopped = opened;
      }
    const inserted = runId
      ? await insertEvaluationTargets(db, runId, page.targets)
      : 0;
    return {
      outcome: "admitted" as const,
      scanned: page.scanned,
      inserted,
      next: page.next,
      runId,
      replacing: runId ? null : stopped,
    };
  });
}

/** Records one connection roster page queues, for Sweeps and routine discovery alike; one evaluation page. */
export const CONNECTION_ROSTER_PAGE = 100;

/**
 * Routine discovery pauses while this many connection evaluations wait, so a
 * full pass over every record (~55k) drains at queue pace instead of flooding
 * it. Evaluation pages clear about ten pages of backlog per minute, so the cap
 * keeps several pages queued; the pass keeps its cursor and resumes when the
 * backlog drops.
 */
export const CONNECTION_DISCOVERY_PENDING_CAP = 1_000;

export async function pendingConnectionEvaluations(db: Database) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.feature, "entity-connections"),
        inArray(aiEvaluation.state, [...PENDING_AI_STATES]),
      ),
    );
  return row?.count ?? 0;
}

async function runIsActive(db: Database, runId: RunId) {
  const [row] = await getDb(db)
    .select({ status: run.status })
    .from(run)
    .where(and(eq(run.id, runId), notDeleted(run)));
  return row?.status === "running" || row?.status === "paused";
}

/** How many sources a connection Sweep's scope covers; the roster pages the same predicate. */
export async function countConnectionSweepSources(
  db: Database,
  entityKinds?: readonly string[],
  createdBefore?: Date | null,
) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(entityIdentity)
    .where(sourcePredicate(entityKinds, createdBefore));
  return row?.count ?? 0;
}

const sourcePredicate = (
  entityKinds?: readonly string[],
  createdBefore?: Date | null,
) =>
  and(
    isNull(entityIdentity.deletedAt),
    isNull(entityIdentity.mergedIntoId),
    inArray(entityIdentity.kind, sweepKinds(entityKinds)),
    createdBefore ? lte(entityIdentity.createdAt, createdBefore) : undefined,
  );

const sweepKinds = (entityKinds?: readonly string[]) =>
  entityKinds?.length
    ? discoveryEntities.filter((kind) => entityKinds.includes(kind))
    : [...discoveryEntities];

/**
 * How far the routine pass that owns `runId` has walked its roster, newest
 * first: records at or after its cursor, of every record it covers. Null when
 * no live pass cursor names the Run (a finished pass or another Run).
 */
export async function connectionDiscoveryPosition(db: Database, runId: string) {
  const [pass] = await getDb(db)
    .select({ cursor: job.cursor })
    .from(job)
    .where(
      and(
        eq(job.key, "discovery:connections"),
        sql`${job.cursor}->>'runId' = ${runId}`,
      ),
    )
    .limit(1);
  const after = z
    .object({ after: z.string().nullable() })
    .safeParse(pass?.cursor);
  if (!after.success) return null;
  const total = await countConnectionSweepSources(db);
  const [afterCreatedAt, afterId] = after.data.after?.split("|") ?? [];
  if (!afterCreatedAt || !afterId) return { walked: 0, total };
  const [row] = await getDb(db)
    .select({ remaining: count() })
    .from(entityIdentity)
    .where(
      and(
        sourcePredicate(),
        or(
          sql`${entityIdentity.createdAt} < ${afterCreatedAt}::timestamp`,
          and(
            sql`${entityIdentity.createdAt} = ${afterCreatedAt}::timestamp`,
            sql`${entityIdentity.id} < ${afterId}::uuid`,
          ),
        ),
      ),
    );
  return { walked: Math.max(0, total - (row?.remaining ?? 0)), total };
}

export const connectionSourceFingerprint = connectionDiscoveryFingerprint;
export const connectionSourceFingerprints = connectionDiscoveryFingerprints;
export const connectionSourceFingerprintsOrMissing =
  connectionDiscoveryFingerprintsOrMissing;

/** Cursor coverage includes records without stock or prior acquisition. */
async function connectionDiscoveryRecords(
  db: Database,
  { after, limit, entityKinds, createdBefore, newestFirst }: RosterInput,
) {
  // Entity ids are random, so newest-first pages by (createdAt, id).
  const [afterCreatedAt, afterId] =
    newestFirst && after ? after.split("|") : [];
  const rows = await getDb(db)
    .select({
      id: entityIdentity.id,
      entity: entityIdentity.kind,
      shortcode: entityIdentity.shortcode,
      // Text keeps microseconds; a Date cursor would skip same-millisecond rows.
      createdAt: sql<string>`${entityIdentity.createdAt}::text`,
    })
    .from(entityIdentity)
    .where(
      and(
        sourcePredicate(entityKinds, createdBefore),
        !after
          ? undefined
          : newestFirst && afterCreatedAt && afterId
            ? or(
                sql`${entityIdentity.createdAt} < ${afterCreatedAt}::timestamp`,
                and(
                  sql`${entityIdentity.createdAt} = ${afterCreatedAt}::timestamp`,
                  sql`${entityIdentity.id} < ${afterId}::uuid`,
                ),
              )
            : gt(entityIdentity.id, after),
      ),
    )
    .orderBy(
      ...(newestFirst
        ? [desc(entityIdentity.createdAt), desc(entityIdentity.id)]
        : [asc(entityIdentity.id)]),
    )
    .limit(limit);
  return rows.flatMap((row) =>
    row.shortcode
      ? [
          {
            id: row.id,
            cursor: newestFirst ? `${row.createdAt}|${row.id}` : row.id,
            source: {
              entityKind: entitySchema.parse(row.entity),
              entityId: row.shortcode,
            },
          },
        ]
      : [],
  );
}

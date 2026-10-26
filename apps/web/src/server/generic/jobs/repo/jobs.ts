import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  jobState,
  enqueueJobInput,
  jobPage,
  type EnqueueJobInput,
  type JobPage,
  type JobWaitReason,
} from "@cubby/schemas/job";
import {
  runStatus,
  runPurpose,
  runTrigger,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import { generateShortcode } from "@cubby/shared";
import {
  and,
  eq,
  getTableColumns,
  gt,
  inArray,
  lte,
  not,
  notInArray,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { outer, related } from "~/server/db/helpers/related";
import { repositorySavepoint } from "~/server/db/repository-access.boundary";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
  repositorySnapshotWriteDatabase,
} from "~/server/db/repository-access.boundary";
import {
  repositoryBeforeCommit,
  repositoryTransactionOn,
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  job,
  jobInvalidation,
  jobInvalidationCapture,
  run,
} from "~/server/db/retained-tables";
import {
  insertPayloadsWithIdentities,
  isEntityShortcodeCollision,
} from "~/server/entity-kernel/repo/entity-identity-writer";
import { findPgError } from "~/server/errors/db-errors";
import { findOrCreateWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { JobRetryableError, JobSupersededError } from "../errors";
import {
  jobKindPolicy,
  neverExhaustedRetryDelayMs,
  NEVER_EXHAUSTED_JOB_KINDS,
  UNDRAINED_JOB_KINDS,
  JOB_KIND_POLICY,
  JOB_BACKGROUND_SHARE,
} from "../kind-policy";
import { JOB_DRAIN } from "../limits";

/** How long a claim holds a Job before another worker may take it over. */
export const JOB_LEASE_MS = 5 * 60_000;
/** Consecutive failures before a Job fails; an enqueue may declare its own. */
export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
/** A failed page waits `baseMs · 2^attempts`, capped at `maxMs`. */
export const JOB_RETRY_BACKOFF = { baseMs: 1_000, maxMs: 60_000 } as const;
export type JobRow = typeof job.$inferSelect;
export type JobClaim = JobRow & {
  /** One drain page token can own several Jobs; fencing always includes Job ID and generation. */
  leaseToken: string;
  leaseExpiresAt: Date;
  /**
   * An external executor reporting after its lease expired still owns the
   * Job while no newer claim replaced its token; only such a claim may
   * publish past `leaseExpiresAt`.
   */
  lateAdoption?: true;
};

/** Whether `row` is still owned by `claim`: same token, and live unless adopted late. */
const ownsLease = (
  row: {
    state: string;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
  },
  claim: Pick<JobClaim, "leaseToken" | "lateAdoption">,
) =>
  row.state === "running" &&
  row.leaseToken === claim.leaseToken &&
  row.leaseExpiresAt !== null &&
  (claim.lateAdoption === true || row.leaseExpiresAt.getTime() > Date.now());

/** Call inside the authoritative save transaction; a queue message is only a wake. */
export async function enqueueJob(
  db: RepositoryQueryInput,
  submitted: EnqueueJobInput,
): Promise<JobRow> {
  const input = enqueueJobInput.parse(submitted);
  const values = {
    key: input.key,
    kind: input.kind,
    input: input.input,
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
    runId: input.runId ? parseEntityId("run", input.runId) : null,
    priority: input.priority ?? 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
    recoveryTimeoutMs: input.recoveryTimeoutMs ?? null,
    lastUsefulProgressAt: input.recoveryTimeoutMs ? new Date() : null,
    availableAt: input.availableAt ?? new Date(),
  };
  return repositoryTransactionOn(db, async (tx) => {
    const found = await findOrCreateWithShortcode(tx, "job", {
      where: eq(job.key, input.key),
      lock: true,
      values: () => values,
    });
    let row: JobRow = found.row;
    if (!found.created && input.invalidate) {
      const [updated] = await tx
        .update(job)
        .set({
          ...values,
          recoveryTimeoutMs:
            input.recoveryTimeoutMs ?? sql`${job.recoveryTimeoutMs}`,
          lastUsefulProgressAt: sql`CASE WHEN coalesce(${input.recoveryTimeoutMs ?? null}, ${job.recoveryTimeoutMs}) IS NOT NULL THEN ${new Date().toISOString()}::timestamp ELSE NULL END`,
          generation: sql`${job.generation} + 1`,
          state: sql`CASE WHEN ${job.state}=${jobState.enum.running} THEN ${jobState.enum.running} ELSE ${jobState.enum.queued} END`,
          cursor: null,
          result: null,
          attempts: 0,
          error: null,
          waitReason: null,
          waitUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(job.id, row.id),
            eq(job.kind, input.kind),
            inArray(job.state, [
              "queued",
              "retry_wait",
              "running",
              "completed",
            ]),
          ),
        )
        .returning();
      if (updated) row = updated;
    }
    if (row.kind !== input.kind)
      throw new Error(
        `Job key ${input.key} belongs to ${row.kind}, not ${input.kind}`,
      );
    return row;
  });
}

/** Insert fresh keyed Jobs and identities in sets. Invalidation stays with enqueueJob. */
export async function enqueueJobs(
  db: Database,
  submitted: readonly EnqueueJobInput[],
): Promise<JobRow[]> {
  const inputs = [
    ...new Map(
      submitted.map((value) => {
        const input = enqueueJobInput.parse(value);
        return [input.key, input] as const;
      }),
    ).values(),
  ];
  if (!inputs.length) return [];
  if (inputs.some((input) => input.invalidate))
    throw new Error("Batch Job enrollment does not invalidate existing Jobs");
  return withTransactionDatabase(db, async (tx) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await getDb(tx)
        .select()
        .from(job)
        .where(
          inArray(
            job.key,
            inputs.map((input) => input.key),
          ),
        )
        .orderBy(job.id)
        .for("update");
      if (
        existing.some((row) =>
          inputs.some(
            (input) => input.key === row.key && input.kind !== row.kind,
          ),
        )
      )
        throw new Error("Job key belongs to a different kind");
      const held = new Set(existing.map((row) => row.key));
      const fresh = inputs.filter((input) => !held.has(input.key));
      if (!fresh.length) return existing;
      try {
        const created = await repositorySavepoint(tx, (client) =>
          insertPayloadsWithIdentities(
            client,
            job,
            "job",
            fresh.map((input) => ({
              key: input.key,
              kind: input.kind,
              input: input.input,
              shortcode: generateShortcode("job"),
              subjectKind: input.subjectKind ?? null,
              subjectId: input.subjectId ?? null,
              runId: input.runId ? parseEntityId("run", input.runId) : null,
              priority: input.priority ?? 0,
              maxAttempts: input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
              recoveryTimeoutMs: input.recoveryTimeoutMs ?? null,
              lastUsefulProgressAt: input.recoveryTimeoutMs ? new Date() : null,
              availableAt: input.availableAt ?? new Date(),
            })),
          ),
        );
        return [...existing, ...created];
      } catch (error) {
        if (
          !isEntityShortcodeCollision(error, "Job") &&
          !(
            findPgError(error)?.code === "23505" &&
            findPgError(error)?.constraint === "Job_key_unique"
          )
        )
          throw error;
      }
    }
    throw new Error(
      "Could not enroll Job page after repeated key/code collisions",
    );
  });
}

/**
 * A durable invalidation this Job has not observed yet (`JobInvalidation`):
 * outstanding work even while the Job row itself reads `completed`.
 * `restartsPass` narrows it to markers whose captures restart a pass.
 */
export const unobservedJobInvalidation = (
  options: { restartsPass?: true } = {},
) =>
  // OFFSET keeps this finite key set out of a correlated nested-loop plan.
  // Bulk claims must not rescan every capture for every unrelated Job.
  sql<boolean>`${job.key} IN (SELECT DISTINCT capture.key FROM "JobInvalidationCapture" capture
    ${options.restartsPass ? sql`JOIN "JobInvalidation" policy ON policy.key=capture.key AND policy."restartsPass"` : sql``}
    WHERE NOT capture.observed OFFSET 0)`;

/**
 * `unobservedJobInvalidation` as key membership, for predicates that scan
 * many Jobs. A correlated EXISTS under OR forces a test of every retained
 * completed row; an array lets the planner reach woken rows through
 * `Job_key_unique` in a BitmapOr. Captures name few distinct keys (a derived
 * drain or ring key each), so the array stays short.
 */
const unobservedJobInvalidationKey = (options: { restartsPass?: true } = {}) =>
  sql<boolean>`${job.key} = ANY (ARRAY(SELECT DISTINCT c.key FROM ${jobInvalidationCapture} c${
    options.restartsPass
      ? sql` JOIN ${jobInvalidation} p ON p.key = c.key AND p."restartsPass"`
      : sql``
  } WHERE NOT c.observed))`;

/** Whether a Job is claimable now: the one predicate the drain, claims and health share. */
export const jobDue = (now: Date) => due(now);

const scheduledDue = (now: Date) =>
  or(
    and(
      inArray(job.state, ["queued", "retry_wait"]),
      lte(job.availableAt, now),
    ),
    and(eq(job.state, "running"), lte(job.leaseExpiresAt, now)),
  );

const due = (now: Date) =>
  or(
    scheduledDue(now),
    // A captured invalidation wakes finished work at once, and waiting work
    // whose capture restarts its pass. A pass that keeps its cursor across
    // captures waits out its availability: its claim does not observe the
    // capture, so the same capture would otherwise bypass every backoff.
    and(eq(job.state, "completed"), unobservedJobInvalidationKey()),
    and(
      inArray(job.state, ["queued", "retry_wait"]),
      unobservedJobInvalidationKey({ restartsPass: true }),
    ),
    // Failure is no stop for new input: execution checks pending captures before a
    // terminal write, so a capture can commit in between, and no transaction
    // shape closes that window without the capture touching the Job row.
    // Waking failed Jobs the restarting capture did not see makes the order
    // irrelevant; the claim starts a fresh pass. Paused and cancelled are
    // member stops and never wake.
    and(
      eq(job.state, "failed"),
      unobservedJobInvalidationKey({ restartsPass: true }),
    ),
  );

/**
 * Append durable input in the source transaction. Existing keys read only
 * stable policy and insert an independent capture: source writers never
 * update each other's capture or the execution Job. Initialization and its
 * first capture/Job commit together, including calls on a pooled handle.
 */
export async function recordJobInvalidation(
  db: RepositoryQueryInput,
  input: Omit<EnqueueJobInput, "invalidate"> & { restartsPass: boolean },
) {
  const { restartsPass, ...enqueue } = input;
  await repositoryTransactionOn(db, async (tx) => {
    const capturedAt = new Date().toISOString();
    const result = await repositoryQueries(tx).execute<{
      initialized: boolean;
      captured: boolean;
      restartsPass: boolean;
    }>(sql`
      WITH policy AS (
        SELECT key, "restartsPass" FROM ${jobInvalidation} WHERE key = ${enqueue.key}
      ), initialized AS (
        INSERT INTO ${jobInvalidation} (key, "restartsPass")
        SELECT ${enqueue.key}, ${restartsPass} WHERE NOT EXISTS (SELECT 1 FROM policy)
        ON CONFLICT (key) DO NOTHING RETURNING key, "restartsPass"
      ), capture AS (
        INSERT INTO ${jobInvalidationCapture} (key, "capturedAt")
        SELECT key, ${capturedAt}::timestamp FROM (
          SELECT key FROM policy UNION ALL SELECT key FROM initialized
        ) owner RETURNING id
      )
      SELECT EXISTS (SELECT 1 FROM initialized) AS initialized,
        EXISTS (SELECT 1 FROM capture) AS captured,
        (SELECT "restartsPass" FROM policy UNION ALL SELECT "restartsPass" FROM initialized) AS "restartsPass"`);
    let recorded = result.rows[0];
    if (recorded && !recorded.captured) {
      // READ COMMITTED can lose first-key insertion to a policy invisible to
      // the original statement. Its initializer committed the Job atomically;
      // a fresh statement can append our input without probing that Job.
      const concurrent = await repositoryQueries(tx).execute<{
        initialized: boolean;
        captured: boolean;
        restartsPass: boolean;
      }>(sql`
        WITH policy AS (
          SELECT key, "restartsPass" FROM ${jobInvalidation} WHERE key = ${enqueue.key}
        ), capture AS (
          INSERT INTO ${jobInvalidationCapture} (key, "capturedAt")
          SELECT key, ${capturedAt}::timestamp FROM policy RETURNING id
        )
        SELECT false AS initialized, EXISTS (SELECT 1 FROM capture) AS captured,
          (SELECT "restartsPass" FROM policy) AS "restartsPass"`);
      recorded = concurrent.rows[0];
    }
    if (!recorded?.captured)
      throw new Error(`Invalidation of ${enqueue.key} not recorded`);
    if (recorded.restartsPass !== restartsPass)
      throw new Error(`Invalidation policy of ${enqueue.key} changed`);
    // Never probe an existing execution row on the ordinary capture path.
    if (recorded.initialized) await enqueueJob(tx, enqueue);
  });
}

/** Expiry revokes ownership; it never reclaims a live lease for another execution. */
async function stopStalledJobs(db: Database) {
  await getDb(db)
    .update(job)
    .set({
      state: "failed",
      error: "Job stopped after its useful-progress recovery window expired",
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(job.state, ["queued", "retry_wait", "running"]),
        sql`${job.recoveryTimeoutMs} IS NOT NULL`,
        NEVER_EXHAUSTED_JOB_KINDS.length
          ? sql`${job.kind} NOT IN (${sql.join(
              NEVER_EXHAUSTED_JOB_KINDS.map((kind) => sql`${kind}`),
              sql`, `,
            )})`
          : undefined,
        sql`coalesce(${job.lastUsefulProgressAt}, ${job.createdAt}) + ${job.recoveryTimeoutMs} * interval '1 millisecond' <= ${new Date().toISOString()}::timestamp`,
      ),
    );
}

/** Backfill (Jobs without an active member-visible Run) keeps this share of every batch. */
export const JOB_BACKFILL_SHARE = 0.2;
/** A kind's slots per fair round: 1 + log10(backlog), at most this many. */
export const JOB_MAX_KIND_WEIGHT = 8;

/** Due work the server drain may claim; parked kinds wait for their own executor. */
const drainedDue = (now: Date) =>
  and(
    due(now),
    UNDRAINED_JOB_KINDS.length
      ? sql`${job.kind} NOT IN (${sql.join(
          UNDRAINED_JOB_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )})`
      : undefined,
  );

/**
 * The drain's fair order. Jobs of a running, member-visible Run lead; then a
 * weighted round-robin across kinds, where a kind's share of each round grows
 * with the log of its backlog (bounded by `JOB_MAX_KIND_WEIGHT`), so a flood
 * of one kind cannot starve another. Within a round the kind claimed least
 * recently goes first; only a claim is service, so invalidations and
 * enqueues leave `lastClaimedAt`. Within a kind, priority then age.
 */
/** A running, member-visible Run that owns the outer `"Job"` row. */
const runOwningJob = () =>
  related(run, (r) => sql`${r.id} = ${outer(job.runId)}`)
    .where(
      (r) =>
        sql`${r.status} = ${runStatus.enum.running} AND ${r.purpose} IN (${sql.join(
          VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
          sql`, `,
        )})`,
    )
    .exists();

/** Whether the outer `"Job"` row belongs to a running, member-visible Run. */
export const jobRunOwned = () => {
  const demand = related(
    run,
    (requester) => sql`(
      (${requester.id}=e."runId" AND NOT EXISTS (SELECT 1 FROM "AiEvaluationRequest" withdrawn WHERE withdrawn."evaluationId"=e.id AND withdrawn."runId"=${requester.id} AND withdrawn."cancelledAt" IS NOT NULL))
      OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" demand WHERE demand."evaluationId"=e.id AND demand."runId"=${requester.id} AND demand."cancelledAt" IS NULL)
    )`,
  )
    .where((requester) =>
      and(
        eq(requester.status, runStatus.enum.running),
        inArray(requester.purpose, VISIBLE_RUN_PURPOSES),
        or(
          ne(requester.purpose, "ai_refresh"),
          ne(requester.trigger, "scheduled"),
        ),
        sql`${requester.retiredAt} IS NULL`,
      )!,
    )
    .exists();
  return sql<boolean>`(("Job"."runId" IS NOT NULL AND ${runOwningJob()}) OR ("Job".kind='ai.evaluation' AND "Job".key IN (SELECT 'ai-evaluation:' || e.id::text FROM "AiEvaluation" e WHERE ${demand})))`;
};

/** Run execution and work of any active Run bypass background admission. */
const jobCapExempt = () =>
  sql<boolean>`(${job.kind} = 'run.execute' OR ${related(
    run,
    (r) =>
      sql`${r.id} = ${outer(job.runId)} AND ${r.status} = ${runStatus.enum.running}`,
  ).exists()})`;

/** Shared with single claims: a page reserves capacity through its live per-target leases. */
async function admitJobKind(
  tx: Database,
  kind: string,
  now: Date,
  pageToken?: string,
) {
  const policy = jobKindPolicy(kind);
  const cap = policy.maxInFlight;
  const maxPages =
    pageToken === undefined ? undefined : policy.maxInFlightPages;
  if (cap === undefined && maxPages === undefined) return true;
  // Match #3322's cross-Worker fence. Never wait while holding candidate Jobs.
  const admission = await getDb(tx).execute<{ locked: boolean }>(sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`job-kind:${kind}`}, 0)) AS locked`);
  if (!admission.rows[0]?.locked) return false;
  const [live] = await getDb(tx)
    .select({
      count: sql<number>`count(*)::int`,
      otherPages: sql<number>`(count(DISTINCT ${job.leaseToken}) FILTER (WHERE ${job.leaseToken} <> ${pageToken ?? null}::uuid))::int`,
    })
    .from(job)
    .where(
      and(
        eq(job.kind, kind),
        eq(job.state, "running"),
        gt(job.leaseExpiresAt, now),
        not(jobCapExempt()),
      ),
    );
  return (
    (cap === undefined || (live?.count ?? 0) < cap) &&
    (maxPages === undefined || (live?.otherPages ?? 0) < maxPages)
  );
}

const kindLimits = Object.keys(JOB_KIND_POLICY).map((kind) => {
  const policy = jobKindPolicy(kind);
  return {
    kind,
    cap: policy.maxInFlight ?? null,
    pages: policy.maxInFlightPages ?? JOB_BACKGROUND_SHARE.maxInFlightPages,
    reserved: policy.reservedConcurrentPages ?? 0,
  };
});

type DueJobSelection = {
  excludeIds?: readonly string[];
  excludeKinds?: readonly string[];
  batchSizes?: ReadonlyMap<string, number>;
};

// Match the canonical key before casting: unmatched historical or synthetic
// keys had no evaluation in the text join and must still produce NULL.
const evaluationIdFromJobKey = (key: SQL) =>
  sql`substring(${key} FROM '^ai-evaluation:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::uuid`;

const fairlyOrderedDueJobs = (
  now: Date,
  perKind: number,
  { excludeIds = [], excludeKinds = [] }: DueJobSelection = {},
) => sql`
  WITH active_runs AS MATERIALIZED (
    SELECT id, "retiredAt" IS NULL AND NOT (purpose = ${runPurpose.enum.ai_refresh} AND trigger = ${runTrigger.enum.scheduled}) AS member_demand, purpose IN (${sql.join(
      VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
      sql`, `,
    )}) AS visible
    FROM "Run" WHERE status = ${runStatus.enum.running} AND ${notDeleted(run)}
  ), pending AS MATERIALIZED (
    SELECT DISTINCT key FROM "JobInvalidationCapture" WHERE NOT observed
  ), due_source AS (
    -- Scan timed work separately from capture wakes: terminal history must not
    -- enter the timed scan just to test a correlated invalidation EXISTS.
    -- Pending keys are distinct and the wake branch excludes timed Jobs, so
    -- UNION ALL preserves one candidate per Job without hashing the backlog.
    SELECT id, key, kind, priority, "updatedAt", "availableAt", "runId" FROM "Job"
    WHERE ${scheduledDue(now)}
      AND ${notInArray(job.kind, [...UNDRAINED_JOB_KINDS])}
    UNION ALL
    SELECT "Job".id, "Job".key, "Job".kind, "Job".priority, "Job"."updatedAt", "Job"."availableAt", "Job"."runId"
    FROM pending JOIN "Job" USING (key) WHERE ${drainedDue(now)}
      AND (${scheduledDue(now)}) IS NOT TRUE
  ), due AS MATERIALIZED (
    SELECT source.id, source.kind, source.priority, source."updatedAt", source."availableAt",
      (coalesce(active_runs.visible, false) OR coalesce(demand.visible, false)) AS run_owned,
      coalesce(page_e.feature, source.kind) AS service_key,
      (source.kind = 'run.execute' OR active_runs.id IS NOT NULL) AS cap_exempt
    FROM due_source source LEFT JOIN active_runs ON active_runs.id = source."runId"
    LEFT JOIN "AiEvaluation" page_e ON source.kind='ai.evaluation' AND page_e.id=${evaluationIdFromJobKey(sql`source.key`)}
    LEFT JOIN LATERAL (
      SELECT true AS visible FROM active_runs requester WHERE requester.visible AND requester.member_demand AND (
        (requester.id=page_e."runId" AND NOT EXISTS (SELECT 1 FROM "AiEvaluationRequest" withdrawn WHERE withdrawn."evaluationId"=page_e.id AND withdrawn."runId"=requester.id AND withdrawn."cancelledAt" IS NOT NULL))
        OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" request WHERE request."evaluationId"=page_e.id AND request."runId"=requester.id AND request."cancelledAt" IS NULL)
      ) LIMIT 1
    ) demand ON page_e.id IS NOT NULL
    WHERE true
      ${
        excludeIds.length
          ? sql`AND source.id NOT IN (${sql.join(
              excludeIds.map((id) => sql`${parseEntityId("job", id)}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
      ${
        excludeKinds.length
          ? sql`AND (source.kind = 'run.execute' OR active_runs.id IS NOT NULL OR source.kind NOT IN (${sql.join(
              excludeKinds.map((kind) => sql`${kind}`),
              sql`, `,
            )}))`
          : sql``
      }
  ), backlog AS MATERIALIZED (
    -- Numeric log is expensive: evaluate the weight once per kind, not once
    -- per row when a consumer expands the backlog join.
    SELECT kind, least(${JOB_MAX_KIND_WEIGHT}, 1 + floor(log(count(*)::numeric))) AS weight
    FROM due GROUP BY kind
  ), capacity AS MATERIALIZED (
    SELECT backlog.kind,
      CASE WHEN policy.cap IS NULL THEN NULL ELSE greatest(0, policy.cap - count("Job".id)) END AS remaining,
      count(DISTINCT "Job"."leaseToken") < coalesce(policy.pages, ${JOB_BACKGROUND_SHARE.maxInFlightPages}) AS page_available
    FROM backlog LEFT JOIN (VALUES ${sql.join(
      kindLimits.map(
        ({ kind, cap, pages }) =>
          sql`(${kind}::text, ${cap}::int, ${pages}::int)`,
      ),
      sql`, `,
    )}) policy(kind, cap, pages) USING (kind)
    LEFT JOIN "Job" ON "Job".kind = backlog.kind AND "Job".state = ${jobState.enum.running}
      AND "Job"."leaseExpiresAt" > ${now.toISOString()}::timestamp
      AND "Job".kind <> 'run.execute'
      AND NOT EXISTS (SELECT 1 FROM active_runs WHERE active_runs.id = "Job"."runId")
    GROUP BY backlog.kind, policy.cap, policy.pages
  ), served AS (
    -- Preserve completed claims as service, using the existing (kind,
    -- lastClaimedAt) index to read only the latest non-null entry per kind.
    SELECT backlog.kind, latest."lastClaimedAt" AS last_served FROM backlog
    LEFT JOIN LATERAL (
      SELECT "lastClaimedAt" FROM "Job" WHERE kind = backlog.kind AND "lastClaimedAt" IS NOT NULL
      ORDER BY "lastClaimedAt" DESC LIMIT 1
    ) latest ON true
  ), services AS MATERIALIZED (
    SELECT DISTINCT kind, service_key FROM due
  ), feature_served AS (
    SELECT services.*, latest."lastClaimedAt" AS feature_last_served
    FROM services LEFT JOIN LATERAL (
      SELECT claimed."lastClaimedAt" FROM "Job" claimed
      JOIN "AiEvaluation" evaluation ON evaluation.id=${evaluationIdFromJobKey(sql`claimed.key`)}
      WHERE services.kind='ai.evaluation' AND claimed.kind=services.kind
        AND evaluation.feature=services.service_key AND claimed."lastClaimedAt" IS NOT NULL
      ORDER BY claimed."lastClaimedAt" DESC LIMIT 1
    ) latest ON true
  ), feature_candidates AS (
    SELECT candidate.*, served.last_served, backlog.weight, feature_served.feature_last_served
    FROM backlog JOIN capacity USING (kind) JOIN served USING (kind)
    JOIN feature_served USING (kind)
    CROSS JOIN (VALUES (true, true), (true, false), (false, true), (false, false)) lane(run_owned, cap_exempt)
    CROSS JOIN LATERAL (
      -- Bound each feature/exemption class before ranking: a feature flood
      -- cannot hide another feature or expand the window over the due set.
      SELECT due.* FROM due WHERE due.kind = backlog.kind
        AND due.service_key = feature_served.service_key
        AND due.run_owned = lane.run_owned AND due.cap_exempt = lane.cap_exempt
      ORDER BY priority DESC, "updatedAt", "availableAt", id
      LIMIT CASE WHEN lane.cap_exempt THEN ${perKind}
        WHEN NOT capacity.page_available THEN 0 ELSE least(${perKind}, capacity.remaining) END
    ) candidate
  ), feature_ranked AS (
    SELECT *, row_number() OVER (
      PARTITION BY run_owned, cap_exempt, kind, service_key ORDER BY priority DESC, "updatedAt", "availableAt", id
    ) AS feature_position FROM feature_candidates
  ), eligible AS (
    SELECT candidate.* FROM backlog JOIN capacity USING (kind)
    CROSS JOIN (VALUES (true, true), (true, false), (false, true), (false, false)) lane(run_owned, cap_exempt)
    CROSS JOIN LATERAL (
      SELECT feature_ranked.* FROM feature_ranked WHERE feature_ranked.kind=backlog.kind
        AND feature_ranked.run_owned=lane.run_owned AND feature_ranked.cap_exempt=lane.cap_exempt
      ORDER BY feature_position, feature_last_served NULLS FIRST, priority DESC, "updatedAt", "availableAt", id
      LIMIT CASE WHEN lane.cap_exempt THEN ${perKind}
        WHEN NOT capacity.page_available THEN 0 ELSE least(${perKind}, capacity.remaining) END
    ) candidate
  ), ranked AS (
    SELECT *, row_number() OVER (
      PARTITION BY run_owned, kind ORDER BY feature_position, feature_last_served NULLS FIRST, priority DESC, "updatedAt", "availableAt", id
    ) AS position FROM eligible
  ), ordered AS (
    SELECT id, kind, run_owned, cap_exempt, service_key,
      row_number() OVER (
        PARTITION BY run_owned
        ORDER BY ceil(position / weight), last_served NULLS FIRST, kind, position
      ) AS class_position,
      row_number() OVER (
        ORDER BY run_owned DESC, ceil(position / weight), last_served NULLS FIRST, kind, position
      ) AS overall
    FROM ranked
  )`;

/** Backfill's reserved slots in a batch of `limit` while it has due work. */
const backfillReserve = (limit: number, backfill: number) =>
  Math.min(backfill, Math.ceil(limit * JOB_BACKFILL_SHARE));

/**
 * One fair batch: run-owned Jobs first, but backfill keeps
 * `JOB_BACKFILL_SHARE` of the batch whenever it has due work.
 */
export async function dueJobs(
  db: Database,
  limit = JOB_DRAIN.batch,
  selection: DueJobSelection = {},
) {
  await stopStalledJobs(db);
  return readDrainDueJobs(db, limit, selection);
}

async function readDrainDueJobs(
  db: Database,
  limit: number,
  selection: DueJobSelection,
) {
  const seedLimit = selection.batchSizes
    ? Math.min(JOB_DRAIN.batch, limit)
    : limit;
  // One snapshot supplies seeds, reserved kinds and every widening group.
  // Keep enough siblings even when all seeds belong to the same batch kind.
  const perKind = selection.batchSizes
    ? seedLimit + Math.min(limit, Math.max(1, ...selection.batchSizes.values()))
    : limit;
  const result = await getDb(db).execute<{
    id: string;
    kind: string;
    run_owned: boolean;
    cap_exempt: boolean;
    service_key: string;
    class_position: number;
  }>(sql`${fairlyOrderedDueJobs(new Date(), perKind, selection)}
    SELECT id, kind, run_owned, cap_exempt, service_key, class_position::int, overall
    FROM ordered
    ORDER BY overall`);
  const pool = result.rows.map((row) => ({
    id: parseEntityId("job", row.id),
    kind: row.kind,
    runOwned: row.run_owned,
    capExempt: row.cap_exempt,
    pageKey:
      row.kind === "ai.evaluation"
        ? JSON.stringify([row.service_key, row.run_owned, row.cap_exempt])
        : null,
    classPosition: row.class_position,
  }));
  const anchors = new Set<string>();
  const services = pool.filter((row) => {
    if (!row.pageKey) return true;
    if (anchors.has(row.pageKey)) return false;
    anchors.add(row.pageKey);
    return true;
  });
  const owned = services.filter(
    (row) => row.runOwned && row.classPosition <= seedLimit,
  );
  const backfill = services.filter(
    (row) => !row.runOwned && row.classPosition <= seedLimit,
  );
  const reserved = backfillReserve(seedLimit, backfill.length);
  const leading = owned.slice(0, Math.max(0, seedLimit - reserved));
  const seeds = [...leading, ...backfill.slice(0, seedLimit - leading.length)];
  const selected = widenDrainSeeds(seeds, pool, limit, selection).map(
    ({ id, kind, runOwned, capExempt, pageKey }) => ({
      id,
      kind,
      runOwned,
      capExempt,
      pageKey,
    }),
  );
  return selected;
}

/** Fair seeds choose page turns; filling a batch never consumes another kind's seed. */
function widenDrainSeeds(
  seeds: {
    id: JobRow["id"];
    kind: string;
    runOwned: boolean;
    capExempt: boolean;
    pageKey: string | null;
  }[],
  pool: typeof seeds,
  limit: number,
  selection: DueJobSelection,
) {
  if (!selection.batchSizes) return seeds;
  // A reservation must enter the selection even when the fair seed window
  // filled with Run work and many other background kinds.
  for (const { kind } of kindLimits.filter((policy) => policy.reserved > 0)) {
    if (seeds.some((seed) => seed.kind === kind)) continue;
    const reserved = pool.find(
      (row) => row.kind === kind && !row.runOwned && !row.capExempt,
    );
    if (!reserved) continue;
    if (seeds.length >= Math.min(JOB_DRAIN.batch, limit)) {
      let replace = seeds.length - 1;
      while (
        replace >= 0 &&
        (jobKindPolicy(seeds[replace]!.kind).reservedConcurrentPages ?? 0) > 0
      )
        replace--;
      if (replace < 0) continue;
      seeds.splice(replace, 1);
    }
    seeds.push(reserved);
  }
  const groups: (typeof seeds)[] = [];
  const batches = new Map<string, typeof seeds>();
  const excluded = new Set(seeds.map((row) => row.id));
  for (const seed of seeds) {
    const size = selection.batchSizes.get(seed.kind) ?? 1;
    const key = `${seed.kind}:${seed.runOwned}:${seed.capExempt}`;
    const existing = batches.get(key);
    if (size > 1 && existing && existing.length < size) existing.push(seed);
    else {
      const group = [seed];
      groups.push(group);
      if (size > 1) batches.set(key, group);
    }
  }
  let allocated = seeds.length;
  for (const group of groups) {
    const first = group[0]!;
    const size = selection.batchSizes.get(first.kind) ?? 1;
    const take = Math.min(size - group.length, limit - allocated);
    if (take <= 0) continue;
    const extra = pool
      .filter(
        (row) =>
          row.kind === first.kind &&
          row.runOwned === first.runOwned &&
          row.capExempt === first.capExempt &&
          !excluded.has(row.id),
      )
      .slice(0, take);
    group.push(...extra);
    for (const row of extra) excluded.add(row.id);
    allocated += extra.length;
  }
  const serviceClass = (group: typeof seeds) =>
    (jobKindPolicy(group[0]!.kind).reservedConcurrentPages ?? 0) > 0
      ? 0
      : group[0]!.runOwned
        ? 1
        : 2;
  return groups.sort((a, b) => serviceClass(a) - serviceClass(b)).flat();
}

/**
 * Page-local waiting positions: earlier due work of the same kind and Run class.
 * Other kinds are interleaved by the drain, so this remains an estimate rather
 * than running its global fair-order projection on every list read.
 */
export async function dueJobPositions(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const result = await getDb(db).execute<{ id: string; ahead: number }>(
    dueJobPositionsQuery(ids),
  );
  return new Map(result.rows.map((row) => [row.id, row.ahead]));
}

/**
 * The list position statement, also used for EXPLAIN evidence. Explicit equal-
 * prefix branches bound each index range; a parameterized row comparison read
 * the whole kind index even for Jobs at its front in PostgreSQL EXPLAIN.
 */
export const dueJobPositionsQuery = (
  ids: readonly string[],
  now = new Date(),
) => sql`
    WITH visible AS MATERIALIZED (
      SELECT id, kind, priority, "updatedAt", "availableAt", ${jobRunOwned()} AS run_owned
      FROM "Job" WHERE ${inArray(
        job.id,
        ids.map((id) => parseEntityId("job", id)),
      )}
        AND ${drainedDue(now)}
    )
    SELECT visible.id, earlier.ahead FROM visible CROSS JOIN LATERAL (
      SELECT count(*)::int AS ahead FROM "Job"
      WHERE "Job".kind = visible.kind AND ${due(now)}
        AND (
          -"Job".priority < -visible.priority
          OR (-"Job".priority = -visible.priority AND "Job"."updatedAt" < visible."updatedAt")
          OR (-"Job".priority = -visible.priority AND "Job"."updatedAt" = visible."updatedAt" AND "Job"."availableAt" < visible."availableAt")
          OR (-"Job".priority = -visible.priority AND "Job"."updatedAt" = visible."updatedAt" AND "Job"."availableAt" = visible."availableAt" AND "Job".id < visible.id)
        )
        AND ${jobRunOwned()} = visible.run_owned
    ) earlier`;

export async function dueJobsAhead(db: Database, id: string) {
  return (await dueJobPositions(db, [id])).get(id) ?? 0;
}

/** Skip a busy Job immediately; a claim never waits behind another worker. */
export async function claimJob(
  db: Database,
  id: string,
  leaseMs = JOB_LEASE_MS,
  { pageToken }: { pageToken?: string } = {},
): Promise<JobClaim | null> {
  const recordId = parseEntityId("job", id);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error("Job lease must be a positive finite duration");
  const now = new Date();
  const token = pageToken ?? crypto.randomUUID();
  return withTransactionDatabase(db, async (tx) => {
    // A fresh claim observes pending input in its own transaction. Only the
    // execution row is locked; source writers append independent captures.
    const [candidate] = await getDb(tx)
      .select({
        row: job,
        pendingCapture: unobservedJobInvalidation(),
        markerRestartsPass: jobInvalidation.restartsPass,
        capExempt: jobCapExempt(),
      })
      .from(job)
      .leftJoin(jobInvalidation, eq(jobInvalidation.key, job.key))
      .where(and(eq(job.id, recordId), due(now)))
      .for("update", { of: job, skipLocked: true });
    if (!candidate) return null;
    const available = candidate.row;
    if (
      !candidate.capExempt &&
      !(await admitJobKind(tx, available.kind, now, pageToken))
    )
      return null;
    const moved = candidate.pendingCapture;
    const restart =
      moved &&
      (available.state === "completed" ||
        available.cursor === null ||
        candidate.markerRestartsPass === true);
    if (restart) {
      available.attempts = 0;
      available.cursor = null;
      available.result = null;
      available.error = null;
      // A fresh pass also gets a fresh recovery window; otherwise a woken
      // stalled Job would fail again at once and wake again on every drain.
      if (available.recoveryTimeoutMs !== null)
        available.lastUsefulProgressAt = now;
    }
    const { retry } = jobKindPolicy(available.kind);
    const stalled =
      retry.exhaust &&
      available.recoveryTimeoutMs !== null &&
      now.getTime() -
        (available.lastUsefulProgressAt ?? available.createdAt).getTime() >=
        available.recoveryTimeoutMs;
    if (
      stalled ||
      (retry.exhaust &&
        available.recoveryTimeoutMs === null &&
        available.attempts >= available.maxAttempts)
    ) {
      await getDb(tx)
        .update(job)
        .set({
          state: "failed",
          waitReason: null,
          waitUntil: null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: stalled
            ? "Job stopped after its useful-progress recovery window expired"
            : "Job exhausted attempts after interrupted execution",
          updatedAt: now,
        })
        .where(eq(job.id, recordId));
      return null;
    }
    const expires = new Date(now.getTime() + leaseMs);
    const [claimed] = await getDb(tx)
      .update(job)
      .set({
        state: "running",
        waitReason: null,
        waitUntil: null,
        leaseToken: token,
        leaseExpiresAt: expires,
        // A never-exhausted kind counts only reported failures: a claim, or
        // reclaiming a vanished executor's expired lease, is not an attempt.
        attempts: retry.exhaust ? available.attempts + 1 : available.attempts,
        lastClaimedAt: now,
        updatedAt: now,
        ...(restart && {
          generation: sql`${job.generation} + 1`,
          cursor: null,
          result: null,
          error: null,
          lastUsefulProgressAt: available.lastUsefulProgressAt,
        }),
      })
      .where(eq(job.id, recordId))
      .returning();
    if (claimed && restart) {
      // This exact visible set, not a maximum UUID/time/revision, is observed.
      // A rolled-back/refused claim leaves every capture pending.
      await getDb(tx)
        .update(jobInvalidationCapture)
        .set({ observed: true })
        .where(
          and(
            eq(jobInvalidationCapture.key, claimed.key),
            eq(jobInvalidationCapture.observed, false),
          ),
        );
    }
    return claimed
      ? { ...claimed, leaseToken: token, leaseExpiresAt: expires }
      : null;
  });
}

/** Claim a finite set in one transaction; each row retains independent ownership. */
export async function claimJobPage(
  db: Database,
  options: { where: SQL; limit: number; leaseMs?: number },
): Promise<JobClaim[]> {
  const leaseMs = options.leaseMs ?? JOB_LEASE_MS;
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw new Error("Job page size must be between 1 and 100");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error("Job lease must be a positive finite duration");
  const now = new Date();
  return withTransactionDatabase(db, async (tx) => {
    const selected = await getDb(tx)
      .select({
        row: job,
        pendingCapture: unobservedJobInvalidation(),
        markerRestartsPass: jobInvalidation.restartsPass,
        capExempt: jobCapExempt(),
      })
      .from(job)
      .leftJoin(jobInvalidation, eq(jobInvalidation.key, job.key))
      .where(and(options.where, due(now)))
      .orderBy(sql`${job.priority} DESC`, job.updatedAt, job.id)
      .limit(options.limit)
      .for("update", { of: job, skipLocked: true });
    const denied = new Set<string>();
    for (const kind of [
      ...new Set(
        selected
          .filter((entry) => !entry.capExempt)
          .map((entry) => entry.row.kind),
      ),
    ].sort())
      if (!(await admitJobKind(tx, kind, now))) denied.add(kind);
    // At cap=1 the entire page enters once; any surviving target lease keeps
    // the kind occupied until the page finishes, including across Workers.
    const candidates = selected.filter(
      (entry) => entry.capExempt || !denied.has(entry.row.kind),
    );
    const exhausted: JobRow["id"][] = [];
    const admitted = candidates.flatMap(
      ({ row, pendingCapture, markerRestartsPass }) => {
        const restart =
          pendingCapture &&
          (row.state === "completed" ||
            row.cursor === null ||
            markerRestartsPass === true);
        const attempts = restart ? 0 : row.attempts;
        const progress = restart
          ? now
          : (row.lastUsefulProgressAt ?? row.createdAt);
        const { retry } = jobKindPolicy(row.kind);
        if (
          retry.exhaust &&
          (row.recoveryTimeoutMs === null
            ? attempts >= row.maxAttempts
            : now.getTime() - progress.getTime() >= row.recoveryTimeoutMs)
        ) {
          exhausted.push(row.id);
          return [];
        }
        return [
          {
            row,
            restart,
            attempts: retry.exhaust ? attempts + 1 : attempts,
            token: crypto.randomUUID(),
          },
        ];
      },
    );
    if (exhausted.length)
      await getDb(tx)
        .update(job)
        .set({
          state: "failed",
          waitReason: null,
          waitUntil: null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: "Job exhausted its interrupted-execution recovery budget",
          updatedAt: now,
        })
        .where(inArray(job.id, exhausted));
    if (!admitted.length) return [];
    const values = sql.join(
      admitted.map(
        ({ row, restart, attempts, token }) =>
          sql`(${row.id}::uuid, ${token}::uuid, ${attempts}::int, ${restart}::boolean)`,
      ),
      sql`, `,
    );
    const rows = await getDb(tx)
      .update(job)
      .set({
        state: "running",
        waitReason: null,
        waitUntil: null,
        leaseToken: sql`page.token`,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: sql`page.attempts`,
        generation: sql`${job.generation} + CASE WHEN page.restart THEN 1 ELSE 0 END`,
        cursor: sql`CASE WHEN page.restart THEN NULL ELSE ${job.cursor} END`,
        result: sql`CASE WHEN page.restart THEN NULL ELSE ${job.result} END`,
        error: sql`CASE WHEN page.restart THEN NULL ELSE ${job.error} END`,
        lastUsefulProgressAt: sql`CASE WHEN page.restart AND ${job.recoveryTimeoutMs} IS NOT NULL THEN ${now.toISOString()}::timestamp ELSE ${job.lastUsefulProgressAt} END`,
        lastClaimedAt: now,
        updatedAt: now,
      })
      .from(sql`(VALUES ${values}) AS page(id, token, attempts, restart)`)
      .where(sql`${job.id} = page.id`)
      .returning(getTableColumns(job));
    const restarted = admitted
      .filter((entry) => entry.restart)
      .map((entry) => entry.row.key);
    if (restarted.length)
      await getDb(tx)
        .update(jobInvalidationCapture)
        .set({ observed: true })
        .where(
          and(
            inArray(jobInvalidationCapture.key, restarted),
            eq(jobInvalidationCapture.observed, false),
          ),
        );
    return rows.flatMap((row) =>
      row.leaseToken && row.leaseExpiresAt
        ? [
            {
              ...row,
              leaseToken: row.leaseToken,
              leaseExpiresAt: row.leaseExpiresAt,
            },
          ]
        : [],
    );
  });
}

/** Exact claim relation used by page renewal, guards and settlement. */
function jobClaimSet(
  claims: readonly Pick<JobClaim, "id" | "leaseToken" | "generation">[],
): SQL {
  if (!claims.length) return sql`false`;
  return sql`(${job.id}, ${job.leaseToken}, ${job.generation}) IN (VALUES ${sql.join(
    claims.map(
      (claim) =>
        sql`(${claim.id}::uuid, ${claim.leaseToken}::uuid, ${claim.generation}::int)`,
    ),
    sql`, `,
  )})`;
}

/** A lost token is returned separately by omission, never renewed with its siblings. */
export async function renewJobPage(
  db: Database,
  claims: readonly JobClaim[],
): Promise<string[]> {
  if (!claims.length) return [];
  const rows = await getDb(db)
    .update(job)
    .set({
      leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        jobClaimSet(claims),
        eq(job.state, "running"),
        sql`${job.leaseExpiresAt} > now()`,
      ),
    )
    .returning({ id: job.id });
  return rows.map((row) => row.id);
}

/** Return unadmitted claims without spending attempts; paused authority stays stopped. */
export async function releaseJobPage(
  db: Database,
  claims: readonly JobClaim[],
  state: "queued" | "paused" = "queued",
) {
  if (!claims.length) return;
  await getDb(db)
    .update(job)
    .set({
      state,
      attempts: sql`greatest(0, ${job.attempts}-1)`,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: new Date(Date.now() + 1000),
      waitReason: null,
      waitUntil: null,
      updatedAt: new Date(),
    })
    .where(and(jobClaimSet(claims), eq(job.state, "running")));
}

/** Lock and validate a set explicitly, independent of AsyncLocal target context. */
export async function guardJobPage(
  db: RepositoryQueryInput,
  claims: readonly JobClaim[],
): Promise<JobClaim[]> {
  if (!claims.length) return [];
  const rows = await getDb(db)
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        jobClaimSet(claims),
        eq(job.state, "running"),
        sql`${job.leaseExpiresAt} > now()`,
        not(unobservedJobInvalidation({ restartsPass: true })),
      ),
    )
    .orderBy(job.id)
    .for("update");
  const valid = new Set(rows.map((row) => row.id));
  return claims.filter((claim) => valid.has(claim.id));
}

/** One final check/hook for an already guarded page; evidence and Jobs commit together. */
export async function completeJobPage(
  db: Database,
  claims: readonly JobClaim[],
) {
  if (!claims.length) return;
  await repositoryBeforeCommit(
    db,
    async (tx) => {
      const valid = await guardJobPage(tx, claims);
      if (valid.length !== claims.length) throw new JobSupersededError();
      await getDb(tx)
        .update(job)
        .set({
          state: "completed",
          attempts: 0,
          error: null,
          waitReason: null,
          waitUntil: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(jobClaimSet(claims));
    },
    { phase: "publication" },
  );
}

/** The token, not the elapsed wall clock alone, owns publication. */
export async function renewJob(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation">,
  { skipLocked = false }: { skipLocked?: boolean } = {},
): Promise<boolean> {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        eq(job.generation, claim.generation),
        sql`${job.leaseExpiresAt} > now()`,
        // Batch heartbeats must not wait behind a sibling's publication lock.
        skipLocked
          ? inArray(
              job.id,
              repositoryQueries(db)
                .select({ id: job.id })
                .from(job)
                .where(eq(job.id, claim.id))
                .for("update", { skipLocked: true }),
            )
          : undefined,
      ),
    )
    .returning({ id: job.id });
  return Boolean(row);
}

/**
 * Hand a claim back without counting an attempt: the executor stopped (or
 * the server could not hand the work over), not the work failing. The Job is
 * due again immediately unless `availableAt` says otherwise.
 */
export async function releaseJobClaim(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation">,
  {
    availableAt = new Date(),
    waitReason = null,
  }: { availableAt?: Date; waitReason?: JobWaitReason | null } = {},
) {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      state: "queued",
      // Exhausting kinds count the claim up front; a release refunds it.
      attempts: sql`CASE WHEN ${inArray(job.kind, [...NEVER_EXHAUSTED_JOB_KINDS])} THEN ${job.attempts} ELSE greatest(0, ${job.attempts} - 1) END`,
      waitReason,
      waitUntil: waitReason ? availableAt : null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        eq(job.generation, claim.generation),
      ),
    )
    .returning({ id: job.id });
  return Boolean(row);
}

/**
 * A restarting invalidation captured since this pass began supersedes the
 * page, as a generation change does. A read only: publication never writes
 * the invalidation row. A capture landing after this check is still seen,
 * because the new capture remains unobserved.
 */
async function invalidatedDuringPass(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "key">,
) {
  const [pending] = await repositoryQueries(db)
    .select({ id: jobInvalidationCapture.id })
    .from(jobInvalidationCapture)
    .innerJoin(
      jobInvalidation,
      eq(jobInvalidation.key, jobInvalidationCapture.key),
    )
    .where(
      and(
        eq(jobInvalidationCapture.key, claim.key),
        eq(jobInvalidationCapture.observed, false),
        eq(jobInvalidation.restartsPass, true),
      ),
    )
    .limit(1);
  return pending !== undefined;
}

/** Preparation/provider work precedes this short transaction; publish is DB-only. */
export async function publishJobPage(
  db: Database,
  claim: JobClaim,
  submitted: JobPage,
  publish?: (tx: Database) => Promise<void | JobPage["result"]>,
  isolationLevel?: "serializable",
): Promise<boolean> {
  const page = jobPage.parse(submitted);
  const transaction =
    isolationLevel === "serializable"
      ? repositorySnapshotWriteDatabase
      : withTransactionDatabase;
  return transaction(db, async (tx) => {
    const [current] = await getDb(tx)
      .select()
      .from(job)
      .where(eq(job.id, claim.id))
      .for("update");
    if (!current || !ownsLease(current, claim)) return false;
    if (
      current.generation !== claim.generation ||
      (await invalidatedDuringPass(tx, claim))
    ) {
      await getDb(tx)
        .update(job)
        .set({
          state: "queued",
          cursor: null,
          waitReason: null,
          waitUntil: null,
          leaseToken: null,
          leaseExpiresAt: null,
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(job.id, claim.id));
      return false;
    }
    const publication = await publish?.(tx);
    const output = publication === undefined ? page.result : publication;
    // Callbacks check this running token again before committing. Complete the
    // Job after those checks and earlier hooks have recorded new work.
    await repositoryBeforeCommit(
      tx,
      async (commit) => {
        const [latest] = await commit
          .select()
          .from(job)
          .where(eq(job.id, claim.id))
          .for("update");
        if (!latest || !ownsLease(latest, claim))
          throw new JobSupersededError();
        if (
          latest.generation !== claim.generation ||
          (await invalidatedDuringPass(commit, claim))
        ) {
          await commit
            .update(job)
            .set({
              state: "queued",
              cursor: null,
              waitReason: null,
              waitUntil: null,
              leaseToken: null,
              leaseExpiresAt: null,
              availableAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(job.id, claim.id));
          return;
        }
        // A pass that does not restart leaves newer captures unobserved:
        // captures made while it ran (an edit behind its cursor, a record
        // created after its cutoff) leave the finished Job due, so the next
        // full pass covers them at once rather than at the next repeat.
        await commit
          .update(job)
          .set({
            state: page.done ? "completed" : "queued",
            cursor: page.cursor ?? null,
            result:
              output &&
              typeof output === "object" &&
              !Array.isArray(output) &&
              current.result &&
              typeof current.result === "object" &&
              !Array.isArray(current.result)
                ? { ...current.result, ...output }
                : (output ?? current.result),
            availableAt: page.waitUntil ?? page.availableAt ?? new Date(),
            waitReason: page.done ? null : (page.waitReason ?? null),
            waitUntil: page.done ? null : (page.waitUntil ?? null),
            leaseToken: null,
            leaseExpiresAt: null,
            attempts: 0,
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(job.id, claim.id));
      },
      { phase: "publication" },
    );
    return true;
  });
}

/** Completed batch pages share source publication and retain every individual lease fence. */
export async function publishCompletedJobPages(
  db: Database,
  entries: readonly { claim: JobClaim; page: JobPage }[],
  publish: (tx: Database, ids: ReadonlySet<string>) => Promise<void>,
): Promise<ReadonlySet<string>> {
  for (const { page } of entries)
    if (!jobPage.parse(page).done)
      throw new Error("Batch publication requires completed pages");
  return withTransactionDatabase(db, async (tx) => {
    const read = () =>
      getDb(tx)
        .select({
          row: job,
          invalidated: sql<boolean>`EXISTS (SELECT 1 FROM ${jobInvalidationCapture} c
        JOIN ${jobInvalidation} i ON i.key=c.key
        WHERE c.key=${outer(job.key)} AND NOT c.observed AND i."restartsPass")`,
        })
        .from(job)
        .where(
          inArray(
            job.id,
            entries.map(({ claim }) => claim.id),
          ),
        )
        .orderBy(job.id)
        .for("update");
    const current = new Map(
      (await read()).map(({ row, invalidated }) => [
        row.id,
        { row, invalidated },
      ]),
    );
    const active = entries.filter(({ claim }) => {
      const found = current.get(claim.id);
      if (!found || !ownsLease(found.row, claim)) return false;
      if (found.row.generation !== claim.generation || found.invalidated)
        throw new JobSupersededError();
      return true;
    });
    const ids = new Set(active.map(({ claim }) => claim.id));
    if (!ids.size) return ids;
    await publish(tx, ids);
    await repositoryBeforeCommit(
      tx,
      async (commit) => {
        const latest = new Map(
          (await read()).map(({ row, invalidated }) => [
            row.id,
            { row, invalidated },
          ]),
        );
        for (const { claim } of active) {
          const found = latest.get(claim.id);
          if (
            !found ||
            !ownsLease(found.row, claim) ||
            found.row.generation !== claim.generation ||
            found.invalidated
          )
            throw new JobSupersededError();
        }
        const records = JSON.stringify(
          active.map(({ claim, page }) => ({
            id: claim.id,
            cursor: page.cursor ?? null,
            result: page.result ?? null,
            availableAt: (
              page.waitUntil ??
              page.availableAt ??
              new Date()
            ).toISOString(),
          })),
        );
        await commit.execute(sql`UPDATE "Job" j SET state=${jobState.enum.completed}, cursor=p.cursor,
        result=CASE WHEN jsonb_typeof(j.result)='object' AND jsonb_typeof(p.result)='object'
          THEN j.result || p.result ELSE coalesce(p.result,j.result) END,
        "availableAt"=p."availableAt", "waitReason"=NULL, "waitUntil"=NULL,
        "leaseToken"=NULL, "leaseExpiresAt"=NULL, attempts=0, error=NULL, "updatedAt"=now()
        FROM jsonb_to_recordset(${records}::jsonb) p(id uuid,cursor jsonb,result jsonb,"availableAt" timestamp)
        WHERE j.id=p.id`);
      },
      { phase: "publication" },
    );
    return ids;
  });
}

export async function failJob(
  db: Database,
  claim: JobClaim,
  error: UnparsedError,
) {
  const message = JSON.stringify(describeErrorCauses(error));
  // A restarting invalidation captured during this pass outranks its
  // failure: the failed page read stale inputs, so the Job starts a fresh
  // claimable pass with a fresh budget instead of failing or backing off
  // and stranding the captured work. The prior error stays for diagnosis.
  if (await invalidatedDuringPass(db, claim)) {
    await getDb(db)
      .update(job)
      .set({
        state: "queued",
        cursor: null,
        attempts: 0,
        availableAt: new Date(),
        waitReason: null,
        waitUntil: null,
        leaseToken: null,
        leaseExpiresAt: null,
        error: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(job.id, claim.id),
          eq(job.state, "running"),
          eq(job.leaseToken, claim.leaseToken),
        ),
      );
    return;
  }
  const { retry } = jobKindPolicy(claim.kind);
  const transient = error instanceof JobRetryableError;
  // A never-exhausted kind counts this reported failure here, not at claim.
  const failures = retry.exhaust ? claim.attempts : claim.attempts + 1;
  await getDb(db)
    .update(job)
    .set({
      state:
        !transient &&
        retry.exhaust &&
        claim.recoveryTimeoutMs === null &&
        claim.attempts >= claim.maxAttempts
          ? "failed"
          : "retry_wait",
      attempts: failures,
      // Claims enforce the budget too; a transient failure reserves its next attempt.
      ...(transient
        ? { maxAttempts: Math.max(claim.maxAttempts, failures + 1) }
        : {}),
      availableAt: new Date(
        Date.now() +
          (retry.exhaust
            ? Math.min(
                JOB_RETRY_BACKOFF.maxMs,
                JOB_RETRY_BACKOFF.baseMs * 2 ** claim.attempts,
              )
            : neverExhaustedRetryDelayMs(retry, failures)),
      ),
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      error: message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        eq(job.generation, claim.generation),
      ),
    );
  // A failed superseded page cannot strand a newer capture behind its old lease.
  await getDb(db)
    .update(job)
    .set({
      state: "queued",
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        sql`${job.generation} <> ${claim.generation}`,
      ),
    );
}

export async function retryJob(
  db: Database,
  id: string,
  recoveryTimeoutMs?: number,
) {
  const recordId = parseEntityId("job", id);
  return withTransactionDatabase(db, async (tx) => {
    const [previous] = await getDb(tx)
      .select()
      .from(job)
      .where(
        and(
          eq(job.id, recordId),
          inArray(job.state, ["failed", "paused", "cancelled"]),
        ),
      )
      .for("update");
    if (!previous) return null;
    if (previous.kind === "embedding.refresh") {
      // An interrupted upload may already be queued for deletion. A retry always gets a fresh physical ID.
      await getDb(tx)
        .update(job)
        .set({ key: `${previous.key}:retired:${previous.id}` })
        .where(eq(job.id, recordId));
      return enqueueJob(tx, {
        key: previous.key,
        kind: previous.kind,
        input: previous.input,
        subjectKind: previous.subjectKind,
        subjectId: previous.subjectId,
        maxAttempts: previous.maxAttempts,
        priority: previous.priority,
      });
    }
    const recovery = recoveryTimeoutMs ?? previous.recoveryTimeoutMs;
    const [row] = await getDb(tx)
      .update(job)
      .set({
        state: "queued",
        attempts: 0,
        recoveryTimeoutMs: recovery,
        lastUsefulProgressAt: recovery ? new Date() : null,
        generation: sql`${job.generation} + 1`,
        error: null,
        waitReason: null,
        waitUntil: null,
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(job.id, recordId))
      .returning();
    return row ?? null;
  });
}

/**
 * Retry now, set-based: matching Jobs become due immediately with backoff and
 * provider waits cleared; prior errors stay for diagnosis. Failed and
 * cancelled Jobs reopen with a fresh attempt budget and generation. Running
 * and member-paused Jobs are left alone.
 */
export async function retryJobsNow(db: Database, where: SQL) {
  const client = repositoryQueries(db);
  // A stopped embedding upload needs a fresh physical ID (`retryJob`).
  const embeddings = await client
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        where,
        eq(job.kind, "embedding.refresh"),
        inArray(job.state, ["failed", "cancelled"]),
      ),
    );
  const retried: string[] = [];
  for (const { id } of embeddings) {
    const row = await retryJob(db, id);
    if (row) retried.push(row.id);
  }
  const now = new Date();
  const reopened = await client
    .update(job)
    .set({
      state: "queued",
      attempts: 0,
      generation: sql`CASE WHEN ${job.state} IN (${jobState.enum.failed}, ${jobState.enum.cancelled}) THEN ${job.generation} + 1 ELSE ${job.generation} END`,
      lastUsefulProgressAt: sql`CASE WHEN ${job.recoveryTimeoutMs} IS NULL THEN NULL ELSE ${now.toISOString()}::timestamp END`,
      availableAt: now,
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        where,
        inArray(job.state, ["queued", "retry_wait", "failed", "cancelled"]),
        sql`NOT (${job.kind} = 'embedding.refresh' AND ${job.state} IN (${jobState.enum.failed}, ${jobState.enum.cancelled}))`,
      ),
    )
    .returning({ id: job.id });
  return [...retried, ...reopened.map((row) => row.id)];
}

export async function cancelJob(db: RepositoryQueryInput, id: string) {
  return controlJob(db, id, "cancelled");
}

export async function pauseJob(db: RepositoryQueryInput, id: string) {
  return controlJob(db, id, "paused");
}

export async function pauseClaimedJob(
  db: Database,
  claim: JobClaim,
  error: UnparsedError,
) {
  await getDb(db)
    .update(job)
    .set({
      state: "paused",
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      error: JSON.stringify(describeErrorCauses(error)),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.generation, claim.generation),
        eq(job.leaseToken, claim.leaseToken),
      ),
    );
}

/**
 * Companion receipts use the exact universal claim that authorized their
 * capability. `lateAdoption` also returns an expired lease no newer claim has
 * replaced, so a late result is adopted rather than dropped.
 */
export async function externalJobClaim(
  db: RepositoryQueryInput,
  key: string,
  token?: string,
  lock = false,
  { lateAdoption = false }: { lateAdoption?: boolean } = {},
): Promise<JobClaim | null> {
  const query = repositoryQueries(db)
    .select()
    .from(job)
    .where(
      and(
        eq(job.key, key),
        eq(job.state, "running"),
        token ? eq(job.leaseToken, token) : undefined,
      ),
    );
  const [row] = await (lock ? query.for("update") : query);
  if (!row?.leaseToken || !row.leaseExpiresAt) return null;
  const claim = {
    ...row,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
  };
  if (row.leaseExpiresAt.getTime() > Date.now()) return claim;
  return lateAdoption ? { ...claim, lateAdoption: true as const } : null;
}

async function controlJob(
  db: RepositoryQueryInput,
  id: string,
  state: "paused" | "cancelled",
) {
  const recordId = parseEntityId("job", id);
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      state,
      generation: sql`${job.generation} + 1`,
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, recordId),
        inArray(job.state, ["queued", "running", "retry_wait", "paused"]),
      ),
    )
    .returning();
  return row ?? null;
}

/** Routine passes can repeat completed work, but never revive a member control or exhausted failure. */
export async function repeatJob(
  db: RepositoryQueryInput,
  input: EnqueueJobInput,
  intervalMs = 0,
) {
  const row = await enqueueJob(db, input);
  if (
    row.state !== "completed" ||
    Date.now() - row.updatedAt.getTime() < intervalMs
  )
    return row;
  const [repeated] = await repositoryQueries(db)
    .update(job)
    .set({
      state: "queued",
      generation: sql`${job.generation} + 1`,
      cursor: null,
      result: null,
      attempts: 0,
      input: input.input,
      waitReason: null,
      waitUntil: null,
      availableAt: input.availableAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, row.id),
        eq(job.state, "completed"),
        // A capture already made it due; requeueing would only move its
        // availability and redate the pending work in health.
        not(unobservedJobInvalidation()),
      ),
    )
    .returning();
  return repeated ?? row;
}

/** Used by domain receipt transactions before applying externally prepared results. */
export async function assertJobClaim(
  db: RepositoryQueryInput,
  claim: JobClaim,
  lock?: "share" | "update",
) {
  const query = repositoryQueries(db)
    .select({ leaseExpiresAt: job.leaseExpiresAt })
    .from(job)
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.generation, claim.generation),
        eq(job.leaseToken, claim.leaseToken),
      ),
    );
  const [current] = await (lock ? query.for(lock) : query);
  if (
    !current?.leaseExpiresAt ||
    (!claim.lateAdoption && current.leaseExpiresAt.getTime() <= Date.now())
  )
    throw new JobSupersededError();
}

export { JobSupersededError } from "../errors";

/**
 * Cancel every active Job matching `where` in one statement. Callers holding
 * a global lock (Run cancel holds AI admission) must never loop per row.
 */
export async function cancelJobsWhere(db: RepositoryQueryInput, where: SQL) {
  return repositoryQueries(db)
    .update(job)
    .set({
      state: "cancelled",
      generation: sql`${job.generation} + 1`,
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        where,
        inArray(job.state, ["queued", "running", "retry_wait", "paused"]),
      ),
    )
    .returning({ id: job.id });
}

/**
 * A cancelled Run stops its own Jobs. Never-exhausted work (image
 * processing) belongs to its subject, not the Run that requested it: it
 * keeps running and only loses the Run's priority.
 */
export async function cancelRunJobs(db: RepositoryQueryInput, runId: string) {
  await repositoryQueries(db)
    .update(job)
    .set({
      state: "cancelled",
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.runId, parseEntityId("run", runId)),
        inArray(job.state, ["queued", "running", "retry_wait", "paused"]),
        NEVER_EXHAUSTED_JOB_KINDS.length
          ? notInArray(job.kind, [...NEVER_EXHAUSTED_JOB_KINDS])
          : undefined,
      ),
    );
}

/** A larger member budget may bring due work forward; stopped Jobs stay stopped. */
export async function bringQueuedJobsForward(db: Database, now: Date) {
  return getDb(db)
    .update(job)
    .set({ availableAt: now, waitUntil: null, waitReason: null })
    .where(
      and(
        inArray(job.state, ["queued", "retry_wait"]),
        gt(job.availableAt, now),
      ),
    )
    .returning({ id: job.id });
}

/** Acquire before domain locks; the returned stamp commits with genuinely new work.
 * This avoids upgrading a shared ownership fence after concurrent domain writes. */
export async function lockJobProgress(
  db: RepositoryQueryInput,
  claim: JobClaim,
) {
  if (claim.recoveryTimeoutMs === null) return async () => {};
  await assertJobClaim(db, claim, "update");
  await repositoryBeforeCommit(
    db,
    (tx) => assertJobClaim(tx, claim, "update"),
    { phase: "publication" },
  );
  return async () => {
    await repositoryQueries(db)
      .update(job)
      .set({ lastUsefulProgressAt: new Date() })
      .where(
        and(
          eq(job.id, claim.id),
          eq(job.generation, claim.generation),
          eq(job.leaseToken, claim.leaseToken),
        ),
      );
  };
}

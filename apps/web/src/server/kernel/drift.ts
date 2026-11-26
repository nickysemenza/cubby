/**
 * Changes that would rewrite history (ADR 0029 section 11). The
 * `version.sweep` pass visits each scope derived under older rules and
 * computes its output from existing answers only: no difference and no
 * missing answer advances the scope's rules; no difference and only asks
 * that fill values no accepted record holds dirties the scope so its normal
 * run files them; anything else becomes a `Drift` proposal that waits on
 * the member.
 * Approval is a decision bound to the proposal hash; it applies the
 * difference and files the asks. Item and class approval release the scope's
 * baseline bindings; unchanged-class approval keeps them.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { BindingBasis } from "@cubby/schemas/kernel/machinery";
import { resolveStage, nextActor } from "@cubby/schemas/kernel/stage";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { withDatabaseOperationPhase } from "~/server/db/db-observability";
import { drift } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";

import { applyComputed } from "./apply";
import { APPROVAL_REASON, CLAIM_LEASE_MS, type ClaimedScope } from "./claim";
import {
  computeBatch,
  recordEntity,
  usedInputs,
  type Computed,
} from "./compute";
import { decide } from "./decide";
import {
  definePass,
  type Pass,
  type Reconciler,
  type ScopeRef,
} from "./define";
import {
  changesNoRecord,
  changesNoRecordSql,
  describeDifference,
  difference,
  isEmptyDifference,
  newAttachments,
  type Difference,
} from "./diff";
import { markDirty, readGatedKeyRevs } from "./dirty";
import { householdWrite, takeHouseholdGate } from "./gate";
import { heldBaselineGap } from "./held-gap";
import { driftSubject, hashCanonical } from "./keys";
import type { KernelRegistry } from "./registry";
import {
  scopeDependencyChanges,
  scopeDependencyPages,
} from "./scope-dependencies";
import { fromIso, isoText } from "./sql-time";
import { wakeAfterCommit, wakeClaimRecovery } from "./wake";

type Q = Pick<RepositoryQueryClient, "execute" | "insert" | "select">;

export const VERSION_SWEEP = "version.sweep";
const SWEEP_PAGE = 20;

const sweepCursor = z
  .object({ kind: z.string(), after: z.string() })
  .nullable();

/** A baseline binding replaced by an equal derived one is not a disagreement. */
function semanticallyEmpty(diff: Difference): boolean {
  const added = new Set(
    diff.bindingsAdd.map(
      (entry) => `${entry.fact.kind}:${entry.fact.id}:${entry.eventKey}`,
    ),
  );
  const agreeing = new Set(
    diff.bindingsRemove
      .filter(
        (entry) =>
          entry.basis === "baseline" &&
          added.has(`${entry.fact.kind}:${entry.fact.id}:${entry.eventKey}`),
      )
      .map((entry) => `${entry.fact.kind}:${entry.fact.id}:${entry.eventKey}`),
  );
  return isEmptyDifference({
    ...diff,
    bindingsAdd: diff.bindingsAdd.filter(
      (entry) =>
        !agreeing.has(`${entry.fact.kind}:${entry.fact.id}:${entry.eventKey}`),
    ),
    bindingsRemove: diff.bindingsRemove.filter(
      (entry) =>
        // Accepted manual snapshots are baseline metadata, not record differences.
        !(
          entry.basis === "baseline" &&
          (entry.fact.kind === "manualEntry" ||
            entry.eventKey.startsWith("baseline:empty:") ||
            entry.eventKey.startsWith("baseline:snapshot:"))
        ) &&
        !agreeing.has(`${entry.fact.kind}:${entry.fact.id}:${entry.eventKey}`),
    ),
  });
}

/**
 * The stale-scope predicate the sweep and its trigger share. The trigger asks
 * with `<` and `>` separately so each probe is one index range.
 */
const stale = (reconciler: Reconciler, differs: SQL = sql`<>`) => sql`
  s."scopeKind" = ${reconciler.scope} AND s.rules ${differs} ${reconciler.rules}
  AND NOT EXISTS (SELECT 1 FROM "ScopeDirty" d
    WHERE d."scopeKind" = s."scopeKind" AND d."scopeKey" = s."scopeKey")
  AND NOT EXISTS (SELECT 1 FROM "Drift" p
    WHERE p."scopeKind" = s."scopeKind" AND p."scopeKey" = s."scopeKey"
      AND p.rules = ${reconciler.rules})`;

/**
 * Fence one page's input revisions, then publish it: clean scopes advance with
 * their dependencies and stale proposals cleared; a scope whose only change is
 * asks that fill values no accepted record holds goes dirty, so its normal run
 * files them; the rest become proposals that wait on the member. Sweep tables
 * hold no money-lane column; the caller's transaction opens with the write
 * gate, before any row this page locks, so the revision read here follows it.
 */
async function proposeOrAdvance(
  tx: Database,
  registry: KernelRegistry,
  computed: readonly Computed[],
): Promise<void> {
  const q = repositoryQueries(tx);
  const plans = computed.flatMap((entry) => {
    if (entry.error !== null || !entry.desired) return [];
    const diff = difference(entry, { releaseBaseline: true });
    // Attaching an existing record is an ownership change, never clean.
    const unchanged =
      semanticallyEmpty(diff) &&
      !entry.desired.disagreements.length &&
      !newAttachments(entry).length;
    return [
      {
        computed: entry,
        diff,
        clean: unchanged && !entry.missing.length,
        fill: unchanged && entry.missing.every((missing) => missing.fill),
      },
    ];
  });
  const keys = [
    ...new Set(plans.flatMap((plan) => [...plan.computed.keys.keys()])),
  ].sort();
  const revisions = await readGatedKeyRevs(q, keys);
  const fenced = plans.filter((plan) =>
    [...plan.computed.keys].every(([key, rev]) => revisions.get(key) === rev),
  );
  const clean = fenced
    .filter((plan) => plan.clean)
    .map(({ computed: entry }) => {
      const gaps = entry.desired!.gaps;
      return {
        kind: entry.scope.kind,
        key: entry.scope.key,
        version: entry.reconciler.version,
        rules: entry.reconciler.rules,
        gaps,
        inputs: usedInputs(entry),
        stage: resolveStage({
          ended: false,
          stuck: false,
          working: false,
          gaps,
        }),
        nextActor: nextActor(gaps),
        firstGap: gaps[0]?.input ?? null,
        inputsHash: entry.inputsHash,
        durationMs: Math.round(entry.durationMs),
        keys: [...entry.keys.keys()],
      };
    });
  // A scope that went dirty keeps its version, dependencies and proposal.
  // Dependencies are replaced by difference so the delete and insert touch
  // disjoint rows within the one statement.
  for (const page of scopeDependencyPages(clean))
    await q.execute(sql`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(page)}::jsonb) AS incoming(
          kind text, key text, version int, rules text, gaps jsonb, inputs jsonb, stage text,
          "nextActor" text, "firstGap" text, "inputsHash" text, "durationMs" int, keys jsonb)
      ), advanced AS (
        UPDATE "ScopeState" s SET version = incoming.version, rules = incoming.rules,
          gaps = incoming.gaps, inputs = incoming.inputs, stage = incoming.stage,
          "nextActor" = incoming."nextActor", "firstGap" = incoming."firstGap",
          "inputsHash" = incoming."inputsHash", "durationMs" = incoming."durationMs",
          "reconciledAt" = now(), "errorClass" = NULL, error = NULL
        FROM incoming
        WHERE s."scopeKind" = incoming.kind AND s."scopeKey" = incoming.key
          AND NOT EXISTS (SELECT 1 FROM "ScopeDirty" d WHERE d."scopeKind" = s."scopeKind" AND d."scopeKey" = s."scopeKey")
        RETURNING s."scopeKind" AS kind, s."scopeKey" AS key, incoming.keys
      ), ${scopeDependencyChanges("advanced")}
      DELETE FROM "Drift" p USING advanced
      WHERE p."scopeKind" = advanced.kind AND p."scopeKey" = advanced.key`);
  const fills = fenced.filter((plan) => !plan.clean && plan.fill);
  if (
    fills.length &&
    (await markDirty(q, registry, {
      keys: [],
      discovers: fills.map((plan) => plan.computed.scope),
      reason: "sweep:fill",
    }))
  )
    await wakeAfterCommit(tx);
  const drifts = fenced.filter((plan) => !plan.clean && !plan.fill);
  await recordDrifts(q, drifts, { hold: true });
}

/** Recent answers per feature and tier that set a proposal's cost estimate. */
const COST_HISTORY = 100;

/**
 * What a member approves: the exact difference with the baseline released,
 * the disagreements, the existing records the scope newly attaches (each a
 * new `RecordKey`) and which asks it files, by feature and input hash.
 * Storage and approval derive the hash here so an approval applies only the
 * difference and files only the asks it was shown. Attachments appear only
 * when there are some.
 */
async function proposalOf(computed: Computed, diff: Difference) {
  const attachments = newAttachments(computed);
  const proposal = {
    difference: Object.assign(
      {},
      describeDifference(diff),
      { disagreements: computed.desired?.disagreements ?? [] },
      attachments.length && {
        attachments: attachments.map((entry) => ({
          table: entry.target.name,
          naturalKey: entry.naturalKey,
          id: entry.id,
        })),
      },
    ),
    asks: computed.missing
      .map((missing) => ({
        feature: missing.envelope.feature,
        inputHash: missing.inputHash,
      }))
      .sort((a, b) => {
        const [x, y] = [a, b].map(
          (ask) => `${ask.feature}\u0000${ask.inputHash}`,
        );
        return x! < y! ? -1 : x! > y! ? 1 : 0;
      }),
  };
  return {
    difference: proposal.difference,
    askCount: computed.missing.length,
    proposalHash: await hashCanonical(proposal),
  };
}

/**
 * Store exact proposals in one statement; no producer calls are owed. With
 * `hold`, the same statement gives each scope's state the held-baseline
 * member gap, as a held apply writes it: the scope keeps its version and
 * dependencies until an approval or a later run replaces its gaps. A scope
 * that went dirty keeps its state. Each
 * ask a proposal would file costs the median of the last {@link COST_HISTORY}
 * priced Answers for its feature and requested tier, else the ask kind's
 * declared estimate; a source ask is free. A proposal with any ask of unknown
 * cost stores a NULL estimate. The estimate is not part of the proposal hash:
 * new answers move it without invalidating an approval of the same change.
 */
export async function recordDrifts(
  q: Q,
  proposals: readonly { computed: Computed; diff: Difference }[],
  options: { hold?: boolean } = {},
): Promise<void> {
  if (!proposals.length) return;
  const gaps = [heldBaselineGap()];
  const rows = await Promise.all(
    proposals.map(async ({ computed, diff }) => {
      const proposal = await proposalOf(computed, diff);
      return {
        scopeKind: computed.scope.kind,
        scopeKey: computed.scope.key,
        version: computed.reconciler.version,
        rules: computed.reconciler.rules,
        inputsHash: computed.inputsHash,
        ...proposal,
        asks: computed.missing.map((missing) => ({
          feature: missing.envelope.feature,
          tier: missing.envelope.tier,
          declared:
            missing.kind.estimateCostMicros?.(missing.envelope.input) ??
            (missing.kind.producer === "source" ? 0 : null),
        })),
      };
    }),
  );
  await q.execute(sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS incoming(
        "scopeKind" text, "scopeKey" text, version int, rules text, "proposalHash" text,
        "inputsHash" text, difference jsonb, "askCount" int, asks jsonb)
    ), filed AS (
      SELECT incoming."scopeKind", incoming."scopeKey", ask.feature, ask.tier, ask.declared
      FROM incoming CROSS JOIN LATERAL jsonb_to_recordset(incoming.asks) AS ask(feature text, tier text, declared bigint)
    ), history AS (
      SELECT wanted.feature, wanted.tier, (
        SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY recent."costMicros")
        FROM (SELECT a."costMicros" FROM "Answer" a
          WHERE a.feature = wanted.feature AND a."costMicros" IS NOT NULL
            AND (wanted.tier IS NULL OR a.tier = wanted.tier)
          ORDER BY a."createdAt" DESC LIMIT ${COST_HISTORY}) recent
      ) AS median
      FROM (SELECT DISTINCT feature, tier FROM filed) wanted
    ), cost AS (
      SELECT filed."scopeKind", filed."scopeKey",
        CASE WHEN bool_and(coalesce(history.median, filed.declared) IS NOT NULL)
          THEN sum(coalesce(history.median, filed.declared)) END AS micros
      FROM filed JOIN history
        ON history.feature = filed.feature AND history.tier IS NOT DISTINCT FROM filed.tier
      GROUP BY filed."scopeKind", filed."scopeKey"
    ), held AS (
      UPDATE "ScopeState" s SET gaps = ${JSON.stringify(gaps)}::jsonb,
        stage = ${resolveStage({ ended: false, stuck: false, working: false, gaps })},
        "nextActor" = ${nextActor(gaps)}, "firstGap" = ${gaps[0]!.input}
      FROM incoming
      WHERE ${options.hold === true} AND s."scopeKind" = incoming."scopeKind" AND s."scopeKey" = incoming."scopeKey"
        AND NOT EXISTS (SELECT 1 FROM "ScopeDirty" d
          WHERE d."scopeKind" = s."scopeKind" AND d."scopeKey" = s."scopeKey")
    )
    INSERT INTO "Drift" ("scopeKind", "scopeKey", version, rules, "proposalHash", "inputsHash",
      difference, "askCount", "estimatedCostMicros")
    SELECT incoming."scopeKind", incoming."scopeKey", incoming.version, incoming.rules,
      incoming."proposalHash", incoming."inputsHash", incoming.difference, incoming."askCount",
      CASE WHEN incoming."askCount" = 0 THEN 0 ELSE cost.micros::bigint END
    FROM incoming LEFT JOIN cost USING ("scopeKind", "scopeKey")
    ORDER BY incoming."scopeKind", incoming."scopeKey"
    ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
      version = excluded.version, rules = excluded.rules, "proposalHash" = excluded."proposalHash",
      "inputsHash" = excluded."inputsHash", difference = excluded.difference,
      "askCount" = excluded."askCount", "estimatedCostMicros" = excluded."estimatedCostMicros",
      "updatedAt" = now()`);
}

/** The kernel's own pass: visit every scope derived under older rules. */
export function versionSweepPass(registry: () => KernelRegistry): Pass {
  return definePass({
    name: VERSION_SWEEP,
    async run(db, cursor) {
      const current = registry();
      const kinds = [...current.reconcilers.keys()].sort();
      let position = sweepCursor.parse(cursor) ?? {
        kind: kinds[0] ?? "",
        after: "",
      };
      for (
        let index = kinds.indexOf(position.kind);
        index >= 0 && index < kinds.length;
        index++
      ) {
        const reconciler = current.reconcilers.get(kinds[index]!)!;
        if (position.kind !== reconciler.scope)
          position = { kind: reconciler.scope, after: "" };
        const rows = await repositoryQueries(db).execute<{ key: string }>(sql`
          SELECT s."scopeKey" AS key FROM "ScopeState" s
          WHERE ${stale(reconciler)} AND s."scopeKey" > ${position.after}
          ORDER BY s."scopeKey" LIMIT ${SWEEP_PAGE}`);
        if (!rows.rows.length) continue;
        const computed = await computeBatch(
          repositoryQueries(db),
          current,
          reconciler,
          rows.rows.map((row) => ({ kind: reconciler.scope, key: row.key })),
          { db, locked: false, hideBaseline: true },
        );
        return {
          cursor: { kind: reconciler.scope, after: rows.rows.at(-1)!.key },
          done: false,
          // The page publishes with its cursor, in the pass's fenced transaction.
          publish: (tx) =>
            withDatabaseOperationPhase("apply", () =>
              proposeOrAdvance(tx, current, computed),
            ),
        };
      }
      return { cursor: null, done: true };
    },
  });
}

/** Whether any eligible scope was derived under different rules. */
export async function hasStaleScopes(
  db: Database,
  registry: KernelRegistry,
): Promise<boolean> {
  const reconcilers = [...registry.reconcilers.values()];
  if (!reconcilers.length) return false;
  const q = repositoryQueries(db);
  const rules = JSON.stringify(
    Object.fromEntries(reconcilers.map(({ scope, rules }) => [scope, rules])),
  );
  const token = crypto.randomUUID();
  const check = await q.execute<{ scan: boolean }>(sql`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM "Pass" WHERE name = ${VERSION_SWEEP} AND key = 'eligibility'
        AND cursor = jsonb_build_object('rules', ${rules}::jsonb)
    ) THEN false ELSE cubby_begin_sweep_check(${rules}::jsonb, ${token}::uuid) END AS scan`);
  if (!check.rows[0]?.scan) return false;

  const result = await q.execute<{ stale: boolean }>(sql`
    SELECT ${sql.join(
      reconcilers.flatMap((reconciler) =>
        [sql`<`, sql`>`].map(
          (range) =>
            sql`EXISTS (SELECT 1 FROM "ScopeState" s WHERE ${stale(reconciler, range)})`,
        ),
      ),
      sql` OR `,
    )} AS stale`);
  const staleScopes = result.rows[0]?.stale ?? false;
  if (!staleScopes)
    await q.execute(sql`
      UPDATE "Pass" SET cursor = jsonb_build_object('rules', ${rules}::jsonb)
      WHERE name = ${VERSION_SWEEP} AND key = 'eligibility'
        AND cursor->>'token' = ${token}`);
  return staleScopes;
}

/**
 * Claim a scope for an approval. A clean scope gets a dirty row whose reason
 * carries this approval's token ({@link APPROVAL_REASON}); no runner claims
 * it, even once the lease lapses, so only an approval runs it. A row an
 * earlier approval left behind (its claim released or lapsed) is taken over
 * the same way. A row another writer dirtied is claimed as it stands and stays
 * ordinary work. Also deletes approval rows whose approval ended without
 * cleaning up (a crash or a thrown cleanup), so none outlives the next
 * approval.
 */
async function claimForApproval(
  q: Q,
  registry: KernelRegistry,
  scope: ScopeRef,
): Promise<ApprovalClaim | null> {
  const token = crypto.randomUUID();
  const reason = `${APPROVAL_REASON}${token}`;
  const orphaned = sql`reason LIKE ${`${APPROVAL_REASON}%`}
    AND ("claimToken" IS NULL OR "claimDeadline" <= now())`;
  // Several rows: the gate orders this against every dirtying writer.
  await q.execute(sql`
    WITH gate AS MATERIALIZED (SELECT ${takeHouseholdGate})
    DELETE FROM "ScopeDirty" USING gate WHERE ${orphaned}
      AND NOT ("scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key})`);
  const lease = sql`now() + make_interval(secs => ${CLAIM_LEASE_MS / 1000})`;
  const result = await q.execute<{
    seq: string | number;
    attempts: number;
    conflicts: number;
    updatedAt: string;
    deadline: string;
    owned: boolean;
  }>(sql`
    INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, seq, reason, "claimToken", "claimDeadline", "claimedSeq", "availableAt")
    VALUES (${scope.kind}, ${scope.key}, ${registry.laneOf(scope.kind)}, 1, ${reason},
      ${token}::uuid, ${lease}, 1, ${lease})
    ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET "claimToken" = excluded."claimToken",
      "claimDeadline" = excluded."claimDeadline", "claimedSeq" = "ScopeDirty".seq,
      reason = CASE WHEN "ScopeDirty".reason LIKE ${`${APPROVAL_REASON}%`}
        THEN excluded.reason ELSE "ScopeDirty".reason END
    WHERE "ScopeDirty"."claimToken" IS NULL OR "ScopeDirty"."claimDeadline" <= now()
    RETURNING seq, attempts, conflicts, ${isoText(sql`"updatedAt"`)} AS "updatedAt", ${isoText(sql`"claimDeadline"`)} AS deadline,
      reason = ${reason} AS owned`);
  const row = result.rows[0];
  if (!row) return null;
  await wakeClaimRecovery(new Date(row.deadline));
  return {
    claimed: {
      kind: scope.kind,
      key: scope.key,
      seq: Number(row.seq),
      attempts: row.attempts,
      conflicts: row.conflicts,
      dirtiedAt: fromIso(row.updatedAt) ?? new Date(),
      deadline: new Date(row.deadline),
      token,
    },
    reason: row.owned ? reason : null,
  };
}

/** An approval's claim; `reason` is set when the approval owns the dirty row. */
type ApprovalClaim = { claimed: ClaimedScope; reason: string | null };

/**
 * End an approval that did not apply. The row this approval wrote is deleted
 * only while it still carries this approval's reason: a writer that dirtied
 * the scope since replaced it, and that row stays for the runner. Otherwise
 * the claim is released if this approval still holds it.
 */
async function dropApprovalClaim(
  q: Q,
  { claimed, reason }: ApprovalClaim,
): Promise<void> {
  const scope = sql`"scopeKind" = ${claimed.kind} AND "scopeKey" = ${claimed.key}`;
  if (reason)
    await q.execute(
      sql`DELETE FROM "ScopeDirty" WHERE ${scope} AND reason = ${reason}`,
    );
  await q.execute(
    sql`UPDATE "ScopeDirty" SET "claimToken" = NULL, "claimDeadline" = NULL
      WHERE ${scope} AND "claimToken" = ${claimed.token}::uuid`,
  );
}

/**
 * The baseline binding that holds one owned record: the cutover writes its
 * event key as the record id, or for a `fields` snapshot as
 * `baseline:snapshot:<entity>:<id>`.
 */
const baselineEvents = (entity: string, id: string) => [
  id,
  `baseline:snapshot:${entity}:${id}`,
];

/**
 * Whether the scope holds a baseline, and a baseline binding for every record
 * it owns, so a held run keeps each accepted value. {@link
 * baselineHoldsEveryRecordSql} is the same predicate over the stored rows.
 */
function baselineHoldsEveryRecord(computed: Computed): boolean {
  const events = new Set(
    computed.storedBindings
      .filter(
        (binding) => binding.basis === ("baseline" satisfies BindingBasis),
      )
      .map((binding) => binding.eventKey),
  );
  return (
    events.size > 0 &&
    computed.owned.every((record) =>
      baselineEvents(recordEntity(record.target), record.entityId).some(
        (event) => events.has(event),
      ),
    )
  );
}

const baselineHoldsEveryRecordSql = (kind: SQL, key: SQL) => {
  const baseline = sql`SELECT 1 FROM "EvidenceBinding" b
    WHERE b."scopeKind" = ${kind} AND b."scopeKey" = ${key}
      AND b.basis = ${"baseline" satisfies BindingBasis}`;
  return sql`(EXISTS (${baseline}) AND NOT EXISTS (
    SELECT 1 FROM "RecordKey" k WHERE k."scopeKind" = ${kind} AND k."scopeKey" = ${key}
      AND NOT EXISTS (${baseline} AND b."eventKey" IN (
        k."entityId"::text, 'baseline:snapshot:' || k.entity || ':' || k."entityId"))))`;
};

export type ApprovalOutcome = "applied" | "stale" | "busy" | "missing";

/**
 * What an approval takes. `item`: one proposal by its hash. `class`: up to
 * {@link CLASS_PAGE} proposals of a scope kind. `class_unchanged`: up to
 * {@link CLASS_PAGE} proposals of a scope kind that change no record or
 * ownership ({@link changesNoRecord}); these file their asks and keep the
 * baseline. `item` and `class` release the baseline.
 */
export type ApprovalScope = "item" | "class" | "class_unchanged";

/** Proposals one class approval call takes. */
const CLASS_PAGE = 50;

const disagreementsOf = (difference: unknown): unknown[] =>
  z
    .object({ disagreements: z.array(z.unknown()).default([]) })
    .catch({ disagreements: [] })
    .parse(difference).disagreements;

/**
 * Approve one scope's proposal by its hash. Approval recomputes the scope
 * under the current rules with the baseline released; a proposal stored under
 * other rules, or whose re-derived proposal hash moved, is replaced and must
 * be approved again. A matching one applies exactly that difference under the
 * input fence and files the asks it counted, each proposal in its own gated
 * transaction.
 *
 * Approval wakes the runner after commit however it ends: its decision
 * dirties the scopes that read it, and its publication can file queued Asks
 * without dirtying anything. A stale, conflicting or failed approval leaves no
 * dirty row of its own behind ({@link dropApprovalClaim}).
 */
export async function approveDrift(
  db: Database,
  registry: KernelRegistry,
  actor: ActorContext,
  scope: ScopeRef,
  proposalHash: string,
): Promise<ApprovalOutcome> {
  try {
    return await approveOne(db, registry, actor, scope, proposalHash, {
      recorded: false,
      unchanged: false,
    });
  } finally {
    await wakeAfterCommit(db);
  }
}

async function approveOne(
  db: Database,
  registry: KernelRegistry,
  actor: ActorContext,
  scope: ScopeRef,
  proposalHash: string,
  options: { recorded: boolean; unchanged: boolean },
): Promise<ApprovalOutcome> {
  const q = repositoryQueries(db);
  const [proposal] = await q
    .select()
    .from(drift)
    .where(
      sql`${drift.scopeKind} = ${scope.kind} AND ${drift.scopeKey} = ${scope.key}`,
    );
  if (!proposal) return "missing";
  if (proposal.proposalHash !== proposalHash) return "stale";
  // Evidence or a decision resolves a disagreement; approval cannot.
  if (disagreementsOf(proposal.difference).length) return "stale";
  if (options.unchanged && !changesNoRecord(proposal.difference))
    return "stale";
  if (!options.recorded)
    await decide(db, registry, actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: driftSubject(scope),
        field: "approval",
        value: { scope: "item" satisfies ApprovalScope, proposalHash },
        proposalHash,
      },
    ]);
  const claim = await claimForApproval(q, registry, scope);
  if (!claim) return "busy";
  try {
    return await approveClaimed(db, registry, scope, proposal, claim, options);
  } catch (error) {
    // A thrown cleanup leaves the approval's row to the next approval.
    await dropApprovalClaim(q, claim);
    throw error;
  }
}

async function approveClaimed(
  db: Database,
  registry: KernelRegistry,
  scope: ScopeRef,
  proposal: typeof drift.$inferSelect,
  claim: ApprovalClaim,
  options: { unchanged: boolean },
): Promise<ApprovalOutcome> {
  const q = repositoryQueries(db);
  const { proposalHash } = proposal;
  const reconciler = registry.reconcilers.get(scope.kind)!;
  const [computed] = await computeBatch(q, registry, reconciler, [scope], {
    db,
    locked: false,
    hideBaseline: true,
  });
  // Without a held baseline an answer the unchanged class files would publish
  // its value on the next run: the scope stays pending.
  if (options.unchanged && !baselineHoldsEveryRecord(computed!)) {
    await dropApprovalClaim(q, claim);
    return "stale";
  }
  const rederives = async () => {
    const recomputed = await proposalOf(
      computed!,
      difference(computed!, { releaseBaseline: true }),
    );
    return (
      recomputed.proposalHash === proposalHash &&
      // An unchanged-class approval never applies a proposal that now changes a record.
      (!options.unchanged || changesNoRecord(recomputed.difference))
    );
  };
  if (
    proposal.rules !== reconciler.rules ||
    computed!.error !== null ||
    !computed!.desired ||
    !!computed!.desired.disagreements.length ||
    !(await rederives())
  ) {
    await householdWrite(db, async (tx) => {
      await dropApprovalClaim(repositoryQueries(tx), claim);
      await proposeOrAdvance(tx, registry, [computed!]);
    });
    return "stale";
  }
  const [outcome] = await applyComputed(
    db,
    registry,
    reconciler,
    [computed!],
    [claim.claimed],
    // The unchanged class keeps every accepted value held: a later answer
    // or evidence that would change one becomes a new proposal.
    options.unchanged
      ? { releaseBaseline: false, fileAsks: true, mode: "member" }
      : { releaseBaseline: true, mode: "member" },
  );
  if (outcome!.status === "applied" || outcome!.status === "waiting")
    return "applied";
  await dropApprovalClaim(q, claim);
  return "stale";
}

/**
 * Approve up to {@link CLASS_PAGE} current proposals of one scope kind: one
 * decision naming the scope and hashes, then each proposal in its own gated
 * transaction, one wake. `class_unchanged` takes only proposals that change
 * no record, in scope-key order, and records no decision when none qualifies.
 */
export async function approveDriftClass(
  db: Database,
  registry: KernelRegistry,
  actor: ActorContext,
  kind: string,
  scope: Exclude<ApprovalScope, "item"> = "class",
): Promise<Record<ApprovalOutcome, number>> {
  try {
    return await approveClass(db, registry, actor, kind, scope);
  } finally {
    await wakeAfterCommit(db);
  }
}

async function approveClass(
  db: Database,
  registry: KernelRegistry,
  actor: ActorContext,
  kind: string,
  scope: Exclude<ApprovalScope, "item">,
): Promise<Record<ApprovalOutcome, number>> {
  const unchanged = scope === "class_unchanged";
  const counts = { applied: 0, stale: 0, busy: 0, missing: 0 } satisfies Record<
    ApprovalOutcome,
    number
  >;
  const selection = repositoryQueries(db)
    .select({ key: drift.scopeKey, proposalHash: drift.proposalHash })
    .from(drift);
  const proposals = unchanged
    ? await selection
        .where(
          sql`${drift.scopeKind} = ${kind} AND ${changesNoRecordSql(sql`${drift.difference}`)}
            AND ${baselineHoldsEveryRecordSql(sql`${drift.scopeKind}`, sql`${drift.scopeKey}`)}`,
        )
        .orderBy(drift.scopeKey)
        .limit(CLASS_PAGE)
    : await selection
        .where(sql`${drift.scopeKind} = ${kind}`)
        .limit(CLASS_PAGE);
  if (unchanged && !proposals.length) return counts;
  await decide(db, registry, actor, [
    {
      channel: "assignment",
      kind: "set",
      subject: driftSubject({ kind }),
      field: "approval",
      value: {
        scope,
        proposalHashes: proposals.map((proposal) => proposal.proposalHash),
      },
    },
  ]);
  for (const proposal of proposals)
    counts[
      await approveOne(
        db,
        registry,
        actor,
        { kind, key: proposal.key },
        proposal.proposalHash,
        { recorded: true, unchanged },
      )
    ]++;
  return counts;
}

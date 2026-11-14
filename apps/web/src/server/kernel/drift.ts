/**
 * Changes that would rewrite history (ADR 0029 section 11). The
 * `version.sweep` pass visits each scope derived under older rules and
 * computes its output from existing answers only: no difference and no
 * missing answer advances the scope's rules; no difference and only asks
 * that fill values no accepted record holds dirties the scope so its normal
 * run files them; anything else becomes a `Drift` proposal that waits on
 * the member.
 * Approval is a decision bound to the proposal hash; it applies the
 * difference, files the asks and releases the scope's baseline bindings.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { resolveStage, nextActor } from "@cubby/schemas/kernel/stage";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { withDatabaseOperationPhase } from "~/server/db/db-observability";
import { drift } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";

import { applyComputed } from "./apply";
import { CLAIM_LEASE_MS, releaseClaim, type ClaimedScope } from "./claim";
import { computeBatch, usedInputs, type Computed } from "./compute";
import { decide } from "./decide";
import {
  definePass,
  type Pass,
  type Reconciler,
  type ScopeRef,
} from "./define";
import {
  describeDifference,
  difference,
  isEmptyDifference,
  type Difference,
} from "./diff";
import { lockKeyRevs, markDirty } from "./dirty";
import { heldBaselineGap } from "./held-gap";
import { driftSubject, hashCanonical } from "./keys";
import type { KernelRegistry } from "./registry";
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

/** The stale-scope predicate the sweep and its trigger share. */
const stale = (reconciler: Reconciler) => sql`
  s."scopeKind" = ${reconciler.scope} AND s.rules <> ${reconciler.rules}
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
 * hold no money-lane column; the revision locks take the write gate.
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
    const unchanged =
      semanticallyEmpty(diff) && !entry.desired.disagreements.length;
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
  const revisions = await lockKeyRevs(q, keys);
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
  if (clean.length)
    await q.execute(sql`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(clean)}::jsonb) AS incoming(
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
      ), dependency AS (
        SELECT advanced.kind, advanced.key, read.key AS read
        FROM advanced CROSS JOIN LATERAL jsonb_array_elements_text(advanced.keys) AS read(key)
      ), removed AS (
        DELETE FROM "ScopeDep" d USING advanced
        WHERE d."scopeKind" = advanced.kind AND d."scopeKey" = advanced.key
          AND NOT EXISTS (SELECT 1 FROM dependency
            WHERE dependency.kind = d."scopeKind" AND dependency.key = d."scopeKey" AND dependency.read = d.key)
      ), added AS (
        INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
        SELECT kind, key, read FROM dependency ORDER BY kind, key, read
        ON CONFLICT DO NOTHING
      )
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
 * the disagreements and the ask count. Storage and approval derive the hash
 * here so an approval applies only the difference it was shown.
 */
async function proposalOf(computed: Computed, diff: Difference) {
  const proposal = {
    difference: Object.assign({}, describeDifference(diff), {
      disagreements: computed.desired?.disagreements ?? [],
    }),
    askCount: computed.missing.length,
  };
  return { ...proposal, proposalHash: await hashCanonical(proposal) };
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

/** Whether any scope is derived under rules older than its reconciler's. */
export async function hasStaleScopes(
  db: Database,
  registry: KernelRegistry,
): Promise<boolean> {
  const reconcilers = [...registry.reconcilers.values()];
  if (!reconcilers.length) return false;
  const result = await repositoryQueries(db).execute<{ stale: boolean }>(sql`
    SELECT ${sql.join(
      reconcilers.map(
        (reconciler) =>
          sql`EXISTS (SELECT 1 FROM "ScopeState" s WHERE ${stale(reconciler)})`,
      ),
      sql` OR `,
    )} AS stale`);
  return result.rows[0]?.stale ?? false;
}

/** Claim a scope for an approval, dirtying it if it was clean. */
async function claimForApproval(
  q: Q,
  registry: KernelRegistry,
  scope: ScopeRef,
): Promise<ClaimedScope | null> {
  const token = crypto.randomUUID();
  const result = await q.execute<{
    seq: string | number;
    attempts: number;
    conflicts: number;
    updatedAt: string;
    deadline: string;
  }>(sql`
    INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, seq, reason, "claimToken", "claimDeadline", "claimedSeq")
    VALUES (${scope.kind}, ${scope.key}, ${registry.laneOf(scope.kind)}, 1, ${"drift-approved"},
      ${token}::uuid, now() + make_interval(secs => ${CLAIM_LEASE_MS / 1000}), 1)
    ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET "claimToken" = excluded."claimToken",
      "claimDeadline" = excluded."claimDeadline", "claimedSeq" = "ScopeDirty".seq
    WHERE "ScopeDirty"."claimToken" IS NULL OR "ScopeDirty"."claimDeadline" <= now()
    RETURNING seq, attempts, conflicts, ${isoText(sql`"updatedAt"`)} AS "updatedAt", ${isoText(sql`"claimDeadline"`)} AS deadline`);
  const row = result.rows[0];
  if (row) await wakeClaimRecovery(new Date(row.deadline));
  return row
    ? {
        kind: scope.kind,
        key: scope.key,
        seq: Number(row.seq),
        attempts: row.attempts,
        conflicts: row.conflicts,
        dirtiedAt: fromIso(row.updatedAt) ?? new Date(),
        deadline: new Date(row.deadline),
        token,
      }
    : null;
}

export type ApprovalOutcome = "applied" | "stale" | "busy" | "missing";

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
 * input fence and files the asks it counted.
 */
export async function approveDrift(
  db: Database,
  registry: KernelRegistry,
  actor: ActorContext,
  scope: ScopeRef,
  proposalHash: string,
  options: { recorded?: boolean } = {},
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
  if (!options.recorded)
    await decide(db, registry, actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: driftSubject(scope),
        field: "approval",
        value: { proposalHash },
        proposalHash,
      },
    ]);
  const claimed = await claimForApproval(q, registry, scope);
  if (!claimed) return "busy";
  const reconciler = registry.reconcilers.get(scope.kind)!;
  const [computed] = await computeBatch(q, registry, reconciler, [scope], {
    db,
    locked: false,
    hideBaseline: true,
  });
  if (
    proposal.rules !== reconciler.rules ||
    computed!.error !== null ||
    !computed!.desired ||
    !!computed!.desired.disagreements.length ||
    (
      await proposalOf(
        computed!,
        difference(computed!, { releaseBaseline: true }),
      )
    ).proposalHash !== proposalHash
  ) {
    await releaseClaim(
      q,
      { table: "ScopeDirty", kind: scope.kind, key: scope.key },
      claimed.token,
    );
    await repositoryTransactionDatabase(db, (tx) =>
      proposeOrAdvance(tx, registry, [computed!]),
    );
    return "stale";
  }
  const [outcome] = await applyComputed(
    db,
    registry,
    reconciler,
    [computed!],
    [claimed],
    {
      releaseBaseline: true,
      mode: "member",
    },
  );
  return outcome!.status === "applied" || outcome!.status === "waiting"
    ? "applied"
    : "stale";
}

/** Approve every current proposal of one scope kind: one decision, each proposal applied. */
export async function approveDriftClass(
  db: Database,
  registry: KernelRegistry,
  actor: ActorContext,
  kind: string,
): Promise<Record<ApprovalOutcome, number>> {
  const proposals = await repositoryQueries(db)
    .select({ key: drift.scopeKey, proposalHash: drift.proposalHash })
    .from(drift)
    .where(sql`${drift.scopeKind} = ${kind}`)
    .limit(50);
  await decide(db, registry, actor, [
    {
      channel: "assignment",
      kind: "set",
      subject: driftSubject({ kind }),
      field: "approval",
      value: {
        proposalHashes: proposals.map((proposal) => proposal.proposalHash),
      },
    },
  ]);
  const counts = { applied: 0, stale: 0, busy: 0, missing: 0 } satisfies Record<
    ApprovalOutcome,
    number
  >;
  for (const proposal of proposals)
    counts[
      await approveDrift(
        db,
        registry,
        actor,
        { kind, key: proposal.key },
        proposal.proposalHash,
        {
          recorded: true,
        },
      )
    ]++;
  return counts;
}

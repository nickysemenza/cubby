/**
 * Changes that would rewrite history (ADR 0029 section 11). A version or
 * prompt change never dirties a scope. The `version.sweep` pass visits each
 * scope derived under older rules, computes its output from existing
 * answers only and issues no asks: no difference and no missing answer
 * advances the scope's rules; anything else becomes a `Drift` proposal.
 * Approval is a decision bound to the proposal hash; it applies the
 * difference, files the asks and releases the scope's baseline bindings.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { drift } from "~/server/db/kernel-schema";
import {
  repositoryQueries,
  type RepositoryQueryClient,
} from "~/server/db/repository-access.boundary";

import { applyComputed } from "./apply";
import { CLAIM_LEASE_MS, releaseClaim, type ClaimedScope } from "./claim";
import { computeBatch, type Computed } from "./compute";
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
import { driftSubject, hashCanonical } from "./keys";
import type { KernelRegistry } from "./registry";
import { fromIso, isoText } from "./sql-time";
import { wakeClaimRecovery } from "./wake";

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

/** Advance a scope's rules, or write its proposal. */
async function proposeOrAdvance(
  q: Q,
  computed: Computed,
): Promise<"advanced" | "proposed" | "skipped"> {
  const { scope, reconciler } = computed;
  if (computed.error !== null || !computed.desired) return "skipped";
  const diff = difference(computed, {
    releaseBaseline: true,
  });
  if (semanticallyEmpty(diff) && !computed.missing.length) {
    await q.execute(sql`
      UPDATE "ScopeState" SET version = ${reconciler.version}, rules = ${reconciler.rules}
      WHERE "scopeKind" = ${scope.kind} AND "scopeKey" = ${scope.key}`);
    return "advanced";
  }
  await recordDrift(q, computed, diff);
  return "proposed";
}

/** Store the exact proposal without applying records or owing new producer calls. */
export async function recordDrift(
  q: Q,
  computed: Computed,
  diff: Difference,
): Promise<void> {
  const { scope, reconciler } = computed;
  const proposal = {
    difference: describeDifference(diff),
    askCount: computed.missing.length,
    estimatedCostMicros: computed.missing.reduce(
      (sum, missing) =>
        sum + (missing.kind.estimateCostMicros?.(missing.envelope.input) ?? 0),
      0,
    ),
  };
  const values = {
    version: reconciler.version,
    rules: reconciler.rules,
    proposalHash: await hashCanonical(proposal),
    inputsHash: computed.inputsHash,
    ...proposal,
  };
  await q
    .insert(drift)
    .values({ scopeKind: scope.kind, scopeKey: scope.key, ...values })
    .onConflictDoUpdate({
      target: [drift.scopeKind, drift.scopeKey],
      set: values,
    });
}

/** The kernel's own pass: visit every scope derived under older rules. */
export function versionSweepPass(registry: () => KernelRegistry): Pass {
  return definePass({
    name: VERSION_SWEEP,
    async run(db, cursor, claim) {
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
        await claim.fenced(async (tx) => {
          for (const scope of computed)
            await proposeOrAdvance(repositoryQueries(tx), scope);
        });
        return {
          cursor: { kind: reconciler.scope, after: rows.rows.at(-1)!.key },
          done: false,
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

/**
 * Approve one scope's proposal by its hash. A proposal whose inputs moved is
 * recomputed and must be approved again; a matching one applies the
 * difference without the baseline and files the asks it counted.
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
    computed!.inputsHash !== proposal.inputsHash ||
    computed!.error !== null
  ) {
    await releaseClaim(
      q,
      { table: "ScopeDirty", kind: scope.kind, key: scope.key },
      claimed.token,
    );
    await proposeOrAdvance(q, computed!);
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

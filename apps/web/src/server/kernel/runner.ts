/**
 * The kernel runner (ADR 0029 section 7): drains dirty scopes in batches,
 * kinds taking turns in claim order; runs queued asks; runs due passes; and
 * expires lapsed ask claims. Queue permits and the hourly cron wake it
 * directly; a delivery then offers the least `availableAt` across
 * `ScopeDirty`, `Ask` and `Pass` as the single pending wake (`offerWake`).
 */
import { kernelLane } from "@cubby/schemas/kernel/machinery";
import { sleep } from "@cubby/shared/retry";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryParentDatabase,
  repositoryQueries,
} from "~/server/db/repository-access.boundary";

import { runClaimedScopes } from "./apply";
import { expireAsks, runQueuedAsks } from "./ask";
import {
  claimScopeBatch,
  claimScopes,
  scopeClaimOrder,
  stopUnregisteredWork,
  type ClaimedScope,
} from "./claim";
import { withWorkContext } from "./context";

export { nextWakeSql as kernelNextSql } from "./claim";
import type { Outcome, ScopeRef } from "./define";
import { markDirty } from "./dirty";
import { hasStaleScopes, VERSION_SWEEP } from "./drift";
import { startPass, runOnePass } from "./pass";
import type { KernelRegistry } from "./registry";
import { wakeAfterCommit, wakeClaimRecovery } from "./wake";

const SCOPE_BATCH = 64;
const ASK_BATCH = 4;
const SWEEP_CHECK_MS = 10 * 60_000;
const lastSweepCheck = new WeakMap<KernelRegistry, number>();

/** Start the version sweep when a deploy left scopes on older rules. */
async function ensureVersionSweep(db: Database, registry: KernelRegistry) {
  const checked = lastSweepCheck.get(registry) ?? 0;
  if (Date.now() - checked < SWEEP_CHECK_MS) return;
  lastSweepCheck.set(registry, Date.now());
  const sweep = registry.passes.get(VERSION_SWEEP);
  if (sweep && (await hasStaleScopes(db, registry))) await startPass(db, sweep);
}

/** Where each isolate's next scope batch starts in the claim order. */
const nextKind = new WeakMap<KernelRegistry, number>();

/**
 * One dirty-scope batch. Kinds take turns in claim order across both lanes,
 * continuing after the kind served last, so a kind or lane that never empties
 * cannot hold the others back. A new isolate starts at a random kind: the
 * budget cuts invocations short, and a fixed start would favour its kind.
 */
async function runScopeBatch(
  db: Database,
  registry: KernelRegistry,
): Promise<number> {
  const order = scopeClaimOrder(registry);
  const start =
    nextKind.get(registry) ?? Math.floor(Math.random() * order.length);
  const claimed = await claimScopeBatch(
    repositoryQueries(db),
    [...order.slice(start), ...order.slice(0, start)],
    SCOPE_BATCH,
  );
  if (!claimed.length) return 0;
  const served = order.findIndex(
    (reconciler) => reconciler.scope === claimed[0]!.kind,
  );
  nextKind.set(registry, (served + 1) % order.length);
  await runClaimedScopes(db, registry, order[served]!, claimed, {
    releaseBaseline: false,
    mode: "background",
  });
  return claimed.length;
}

/**
 * How a runner invocation ended: `ran` counts scopes, asks and pass pages;
 * `exhausted` means the budget ended it, not an empty round.
 */
export type KernelRun = { ran: number; exhausted: boolean };

/** Run kernel work until a round finds nothing to claim or the budget is spent. */
export async function runKernel(
  db: Database,
  registry: KernelRegistry,
  options: { budgetMs: number; rulesCheck?: boolean },
): Promise<KernelRun> {
  return withWorkContext(async () => {
    const deadline = Date.now() + options.budgetMs;
    await stopUnregisteredWork(db, registry);
    await expireAsks(db, registry);
    // Queue deliveries skip the rules check: it walks every scope a held
    // proposal keeps stale, and the hourly cron's run performs it.
    if (options.rulesCheck !== false) await ensureVersionSweep(db, registry);
    let ran = 0;
    while (Date.now() < deadline) {
      const scopes = await runScopeBatch(db, registry);
      const asks = await runQueuedAsks(db, registry, ASK_BATCH);
      const passes = (await runOnePass(db, registry)) ? 1 : 0;
      const round = scopes + asks + passes;
      if (!round) return { ran, exhausted: false };
      ran += round;
    }
    return { ran, exhausted: true };
  });
}

/**
 * Run these scopes now for a waiting member: dirty them, claim them as they
 * become free (up to `waitMs`), and apply with the member lock timeout. A
 * scope another worker still holds when the wait ends reports `waiting`.
 * The dirtied scopes wake the runner after the caller's commit whatever
 * happens next, so a failed claim or apply cannot strand them.
 */
export async function reconcileNow(
  db: Database,
  registry: KernelRegistry,
  scopes: readonly ScopeRef[],
  options: { waitMs?: number; runId?: string } = {},
): Promise<Outcome[]> {
  if (!scopes.length) return [];
  await markDirty(repositoryQueries(db), registry, {
    keys: [],
    discovers: scopes,
    reason: "reconcile-now",
  });
  const transactional = repositoryParentDatabase(db) !== undefined;
  // Inside a transaction the wake follows the commit. On a pool handle a wake
  // sent now would hand the fresh scopes to the runner ahead of this call's
  // own claim, so it is sent when the call fails or leaves work behind.
  if (transactional) await wakeAfterCommit(db);
  try {
    return await reconcileDirtied(db, registry, scopes, options, transactional);
  } catch (error) {
    if (!transactional) await wakeAfterCommit(db);
    throw error;
  }
}

async function reconcileDirtied(
  db: Database,
  registry: KernelRegistry,
  scopes: readonly ScopeRef[],
  options: { waitMs?: number; runId?: string },
  transactional: boolean,
): Promise<Outcome[]> {
  const deadline = Date.now() + (transactional ? 0 : (options.waitMs ?? 5_000));
  const pending = new Map(
    scopes.map((scope) => [`${scope.kind}\u0000${scope.key}`, scope]),
  );
  const outcomes = new Map<string, Outcome>();
  while (pending.size) {
    let claimed: ClaimedScope[] = [];
    for (const lane of kernelLane.options) {
      claimed = await claimScopes(
        repositoryQueries(db),
        registry,
        lane,
        Math.min(pending.size, SCOPE_BATCH),
        [...pending.values()],
      );
      if (claimed.length) break;
    }
    if (claimed.length) {
      await wakeClaimRecovery(claimed[0]!.deadline, db);
      const reconciler = registry.reconcilers.get(claimed[0]!.kind)!;
      for (const outcome of await runClaimedScopes(
        db,
        registry,
        reconciler,
        claimed,
        {
          releaseBaseline: false,
          mode: "member",
        },
      )) {
        outcomes.set(
          `${outcome.scope.kind}\u0000${outcome.scope.key}`,
          outcome,
        );
        if (outcome.status !== "conflict")
          pending.delete(`${outcome.scope.kind}\u0000${outcome.scope.key}`);
      }
      continue;
    }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  for (const scope of pending.values())
    outcomes.set(`${scope.kind}\u0000${scope.key}`, {
      scope,
      status: "waiting",
      gaps: [],
    });
  // On a pool handle no wake has gone out yet. Work this call leaves for the
  // runner (a scope still dirty or backing off, or an Ask it queued) needs one.
  if (
    !transactional &&
    [...outcomes.values()].some(
      (outcome) =>
        outcome.status === "conflict" ||
        outcome.status === "failed" ||
        (outcome.status === "waiting" &&
          (!outcome.gaps.length ||
            outcome.gaps.some((gap) => gap.askState === "queued"))),
    )
  )
    await wakeAfterCommit(db);
  if (options.runId) {
    const q = repositoryQueries(db);
    await q.execute(sql`
      INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey", "runId", receipt)
      SELECT DISTINCT a.id, ${"run"}, ${options.runId}, ${options.runId}::uuid,
        (SELECT jsonb_build_object(${"answer"}::text, jsonb_build_object(${"inputHash"}::text, saved."inputHash")) FROM "Answer" saved WHERE saved."inputHash"=a."inputHash")
      FROM jsonb_to_recordset(${JSON.stringify(scopes)}::jsonb) AS wanted(kind text, key text)
      JOIN "ScopeState" state ON state."scopeKind" = wanted.kind AND state."scopeKey" = wanted.key
      JOIN "Ask" a ON EXISTS (
        SELECT 1 FROM "AskScope" waiting WHERE waiting."askId" = a.id
          AND waiting."scopeKind" = wanted.kind AND waiting."scopeKey" = wanted.key
      ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(state.inputs) used
        WHERE used->>${"kind"} = ${"answer"} AND used->>${"inputHash"} = a."inputHash"
      )
      ON CONFLICT DO NOTHING`);
  }
  return [...outcomes.values()];
}

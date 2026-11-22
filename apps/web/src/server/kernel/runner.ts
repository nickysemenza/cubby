/**
 * The kernel runner (ADR 0029 section 7): drains dirty scopes in batches,
 * kinds taking turns in claim order; runs queued asks; runs due passes; and
 * expires lapsed ask claims. Queue permits and the hourly cron wake it
 * directly; the next wake is the least
 * `availableAt` across `ScopeDirty`, `Ask` and `Pass`.
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
 * Run kernel work until nothing is due or the budget is spent. Returns how
 * many units it ran: scopes, asks and pass pages.
 */
export async function runKernel(
  db: Database,
  registry: KernelRegistry,
  options: { budgetMs: number },
): Promise<number> {
  return withWorkContext(async () => {
    const deadline = Date.now() + options.budgetMs;
    await stopUnregisteredWork(db, registry);
    await expireAsks(db, registry);
    await ensureVersionSweep(db, registry);
    let ran = 0;
    while (Date.now() < deadline) {
      const scopes = await runScopeBatch(db, registry);
      const asks = await runQueuedAsks(db, registry, ASK_BATCH);
      const passes = (await runOnePass(db, registry)) ? 1 : 0;
      const round = scopes + asks + passes;
      if (!round) break;
      ran += round;
    }
    return ran;
  });
}

/**
 * Run these scopes now for a waiting member: dirty them, claim them as they
 * become free (up to `waitMs`), and apply with the member lock timeout. A
 * scope another worker still holds when the wait ends reports `waiting`.
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

/**
 * The kernel runner (ADR 0029 section 7): drains dirty scopes in batches,
 * money lane first, in claim order; runs queued asks; runs due passes; and
 * expires lapsed ask claims. Queue permits and the hourly cron wake it
 * through the existing drain machinery; the next wake is the least
 * `availableAt` across `ScopeDirty`, `Ask` and `Pass`.
 */
import { kernelLane } from "@cubby/schemas/kernel/machinery";
import { sleep } from "@cubby/shared/retry";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { runClaimedScopes } from "./apply";
import { expireAsks, runQueuedAsks } from "./ask";
import { claimScopes, MAX_SCOPE_ATTEMPTS, type ClaimedScope } from "./claim";

export { nextWakeSql as kernelNextSql } from "./claim";
import type { Outcome, ScopeRef } from "./define";
import { markDirty } from "./dirty";
import { hasStaleScopes, VERSION_SWEEP } from "./drift";
import { startPass, runOnePass } from "./pass";
import type { KernelRegistry } from "./registry";
import { ASK, KERNEL_UNIT } from "./vocab";

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

/** One dirty-scope batch from the first lane with claimable work. */
async function runScopeBatch(
  db: Database,
  registry: KernelRegistry,
): Promise<number> {
  for (const lane of kernelLane.options) {
    const claimed = await claimScopes(
      repositoryQueries(db),
      registry,
      lane,
      SCOPE_BATCH,
    );
    if (!claimed.length) continue;
    const reconciler = registry.reconcilers.get(claimed[0]!.kind)!;
    await runClaimedScopes(db, registry, reconciler, claimed, {
      releaseBaseline: false,
      mode: "background",
    });
    return claimed.length;
  }
  return 0;
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
  const deadline = Date.now() + options.budgetMs;
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
  const deadline = Date.now() + (options.waitMs ?? 5_000);
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

/** Drain rows `(unit, demand, since)`: one `kernel` unit while any work is due now. */
export const kernelDueSql = (): SQL => sql`
  SELECT ${KERNEL_UNIT}::text AS unit, false AS demand, due.since FROM (
    SELECT least(
      (SELECT min("availableAt") FROM "ScopeDirty"
        WHERE "availableAt" <= now() AND attempts < ${MAX_SCOPE_ATTEMPTS}
          AND ("claimToken" IS NULL OR "claimDeadline" <= now())),
      (SELECT min("availableAt") FROM "Ask"
        WHERE state = ${ASK.queued} AND "cancelledAt" IS NULL AND executor IS NULL AND NOT hosted AND "availableAt" <= now()
          AND attempts < "maxAttempts" AND ("claimToken" IS NULL OR "claimDeadline" <= now())
          AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = "Ask".id AND s."cancelledAt" IS NULL)),
      (SELECT min("claimDeadline") FROM "Ask" WHERE state = ${ASK.sent} AND "claimDeadline" <= now()),
      (SELECT min("availableAt") FROM "Pass"
        WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL AND "availableAt" <= now()
          AND attempts < "maxAttempts" AND ("claimToken" IS NULL OR "claimDeadline" <= now()))
    )::timestamp AS since
  ) due WHERE due.since IS NOT NULL`;

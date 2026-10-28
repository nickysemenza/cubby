import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  backgroundTaskMessageSchema,
  type BackgroundTaskMessage,
} from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";

import { setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { commitRecipeTotals } from "~/server/domains/recipe/repo/totals";
import {
  type DerivedAdapter,
  type DerivedComputes,
  derivedSink,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";
import {
  DERIVED_DRAIN,
  DERIVED_DRAIN_JOB_KEY,
  markAllStoredDerived,
} from "~/server/generic/derived/repo/drain";
import { derivedDrainHandler } from "~/server/generic/derived/service/drain-job";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import {
  claimExternal,
  heldExternalClaim,
  releaseExternalClaim,
} from "~/server/generic/jobs/repo/external-claim";
import { readJob, readJobs } from "~/server/generic/jobs/repo/job-reads";
import { wakeJob } from "~/server/generic/jobs/repo/producer";
import {
  drainItems,
  drainReady,
  postponeWorkRefs,
  workItemsFor,
  workTicketsWhere,
  type WorkItem,
} from "~/server/generic/jobs/repo/work-items";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandler, JobHandlers } from "~/server/generic/jobs/types";
import { derivedComputes } from "~/server/workflows/derived-computes";

const frontierDrains = new WeakMap<Database, Promise<void>>();

/** Fixture seeding and the offline E2E pump settle every derived mark per handle. */
export function drainDerivedRefreshFrontier(
  db: Database,
  maxPages = 1_000,
): Promise<void> {
  const existing = frontierDrains.get(db);
  if (existing) return existing;
  const pending = drainStoredDerived(db, maxPages).finally(() =>
    frontierDrains.delete(db),
  );
  frontierDrains.set(db, pending);
  return pending;
}

/**
 * Drain every ready derived mark through the real `derived.drain` handler and
 * the production compute adapters (or `computes`). Stops once no mark is
 * ready; a failed page throws.
 */
export async function drainStoredDerived(
  db: Database,
  maxPages = 1_000,
  computes: DerivedComputes = derivedComputes,
): Promise<void> {
  for (let page = 0; page < maxPages; page++) {
    if (!(await drainReady(db, DERIVED_DRAIN_JOB_KEY))) return;
    // A running server (E2E) may hold the drain's lease; its page drains the
    // same items, so wait for it instead of failing.
    if (
      (await advanceDerivedPage(db, derivedDrainHandler(computes, 500), {
        allowSkip: true,
      })) === "skipped"
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Stored derived drain exceeded ${maxPages} pages`);
}

/**
 * One real derived drain page. `only` postpones every other ready item for
 * the page; `during` runs once after the page's first compute read its
 * inputs and before publication, the window in which a concurrent write
 * re-tickets or locks a prepared item.
 */
export async function drainDerivedPage(
  db: Database,
  {
    only,
    during,
    computes = derivedComputes,
  }: {
    only?: (item: WorkItem) => boolean;
    during?: () => Promise<void>;
    computes?: DerivedComputes;
  } = {},
): Promise<void> {
  let pending = during;
  const after = async <T>(read: Promise<T>) => {
    const result = await read;
    const run = pending;
    pending = undefined;
    await run?.();
    return result;
  };
  const observed: DerivedComputes = Object.fromEntries(
    Object.entries(computes).map(([key, adapter]): [string, DerivedAdapter] => [
      key,
      isDerivedSink(adapter)
        ? { ...adapter, prepare: (tx, ids) => after(adapter.prepare(tx, ids)) }
        : (tx, ids) => after(adapter(tx, ids)),
    ]),
  );
  const held = only
    ? (await drainItems(db, DERIVED_DRAIN_JOB_KEY)).filter(
        (item) => !only(item),
      )
    : [];
  const byTarget = new Map<string, WorkItem[]>();
  for (const item of held)
    byTarget.set(item.target, [...(byTarget.get(item.target) ?? []), item]);
  for (const [target, items] of byTarget)
    await postponeWorkRefs(
      db,
      target,
      items.map((item) => item.ref),
      new Date(Date.now() + 60 * 60_000),
    );
  try {
    await advanceDerivedPage(db, derivedDrainHandler(observed));
    if (pending) throw new Error("The derived page computed nothing");
  } finally {
    for (const [target, items] of byTarget)
      await postponeWorkRefs(
        db,
        target,
        items.map((item) => item.ref),
        new Date(),
      );
  }
}

async function advanceDerivedPage(
  db: Database,
  handler: JobHandler,
  { allowSkip = false }: { allowSkip?: boolean } = {},
) {
  await wakeJob(db, { ...DERIVED_DRAIN, input: {} });
  // Job retries and waits end now: the helper drains what is ready.
  const [drain] = await updateJobs(
    db,
    { key: DERIVED_DRAIN_JOB_KEY },
    { availableAt: new Date(0), waitReason: null, waitUntil: null },
  );
  if (!drain) throw new Error("Derived drain Job is missing");
  const outcome = await advanceJob(db, drain.id, {
    [DERIVED_DRAIN.kind]: handler,
  });
  if (outcome === "skipped" && allowSkip) return outcome;
  if (outcome !== "succeeded") {
    const failed = await readJob(db, { id: drain.id });
    throw new Error(
      `Derived drain page ${outcome}: ${JSON.stringify(failed?.error)}`,
    );
  }
  return outcome;
}

/**
 * Pending derived marks for `target` (and one record), for invalidation
 * assertions. Without `ref`, fanout marks (`<target>@<input>`) count too.
 */
export const derivedMarkTickets = (
  db: Database,
  target: string,
  ref?: string,
): Promise<number[]> =>
  ref
    ? workItemsFor(db, target, [ref]).then((items) =>
        items.map((item) => item.ticket),
      )
    : workTicketsWhere(
        db,
        DERIVED_DRAIN_JOB_KEY,
        (column) =>
          sql`(${column} = ${target} OR ${column} LIKE ${`${target}@%`})`,
      );

/** Settle derived marks with an optional recipe costing seam (a USDA fixture). */
export async function drainRecipeRefreshJobs(
  db: Database,
  costing?: import("~/server/domains/recipe/repo/recipe-costing").RecipeCostingService,
  maxPages = 1_000,
): Promise<void> {
  if (!costing) return drainStoredDerived(db, maxPages);
  const recipeSink = derivedSink({
    prepare: async (tx, ids) => {
      const totals = new Map<
        string,
        Awaited<
          ReturnType<
            Awaited<ReturnType<typeof costing.prepareRefresh>>["compute"]
          >
        >
      >();
      for (const id of ids)
        // SAFETY: the drain passes ids of `recipe.totals` marks only.
        totals.set(
          id,
          await (
            await costing.bindTo(tx).prepareRefresh(id as RecipeId)
          ).compute(),
        );
      return totals;
    },
    publish: async (tx, ids, totals) => {
      const updates = ids.flatMap((id) => {
        const value = totals.get(id);
        // SAFETY: the drain passes ids of `recipe.totals` marks only.
        return value ? [{ id: id as RecipeId, totals: value }] : [];
      });
      return commitRecipeTotals(tx, { updates, freshOnlyIds: [] });
    },
  });
  return drainStoredDerived(db, maxPages, {
    ...derivedComputes,
    "recipe.totals": recipeSink,
  });
}

/** Exercise broad catch-up: mark every stored value, then drain. */
export async function reconcileDerivedRefreshInputs(
  db: Database,
): Promise<void> {
  await markAllStoredDerived(db);
  await drainDerivedRefreshFrontier(db);
}

/** A lost wake does not hide intent: drain committed Jobs, not captured messages. */
export function captureBackgroundQueue() {
  const messages: BackgroundTaskMessage[] = [];
  setCfEnv(
    fromPartial<Env>({
      BACKGROUND_QUEUE: {
        sendBatch: async (batch: Iterable<{ body: unknown }>) => {
          for (const { body } of batch)
            messages.push(backgroundTaskMessageSchema.parse(body));
        },
      },
    }),
  );
  return {
    messages,
    async drain(
      db: Database,
      options: { maxTasks?: number; handlers?: JobHandlers } = {},
    ): Promise<number> {
      const handlers =
        options.handlers ??
        (await import("~/server/workflows/jobs")).productionJobHandlers;
      const maxPages = options.maxTasks ?? 10_000;
      for (let page = 0; page < maxPages; page++) {
        const [pending] = await readJobs(
          db,
          { kinds: Object.keys(handlers), states: ["queued", "retry_wait"] },
          { order: ["availableAt", "id"], limit: 1 },
        );
        if (!pending) {
          messages.length = 0;
          return page;
        }
        if (pending.state !== "completed" && pending.availableAt > new Date())
          throw new Error(
            `Synthetic drain reached deferred Job ${pending.kind}`,
          );
        const outcome = await advanceJob(db, pending.id, handlers);
        if (outcome === "failed")
          throw new Error(
            `Synthetic Job ${pending.kind} failed; inspect retained Job.error`,
          );
      }
      throw new Error(`Background Job drain exceeded ${maxPages} pages`);
    },
    restore: () => setCfEnv(undefined),
  };
}

/**
 * Domain regression seams execute under the same persisted Job ownership as a
 * worker: `work` receives the claim's context, and a Run Job's work also runs
 * in its Run workflow context, as `run.execute` does.
 */
export async function withJobFixtureExecution<T>(
  db: Database,
  input: import("@cubby/schemas/job").EnqueueJobInput,
  work: (
    context: import("~/server/generic/jobs/service/drain").DrainContext,
  ) => Promise<T>,
  options: { releaseClaim?: true } = {},
) {
  const { enqueueJob } = await import("~/server/generic/jobs/repo/producer");
  const { claimContext } = await import("~/server/generic/jobs/service/jobs");
  const { withJobExecution } = await import("~/server/generic/jobs/context");
  const saved = await enqueueJob(db, input);
  const existing = await heldExternalClaim(db, saved.key);
  const claim = existing ?? (await claimExternal(db, saved.id));
  if (!claim)
    throw new Error(`Synthetic execution ${saved.key} is ${saved.state}`);
  const context = claimContext(db, claim);
  const runId =
    input.kind === "run.execute" &&
    typeof input.input === "object" &&
    input.input !== null &&
    "runId" in input.input
      ? String(input.input.runId)
      : null;
  try {
    return await withJobExecution(db, claim, async () =>
      runId
        ? (
            await import("~/server/workflows/runs/execution")
          ).withWorkflowExecution(
            { runId, attempt: claim.generation, database: db, job: context },
            () => work(context),
          )
        : work(context),
    );
  } finally {
    // Completed fixture work can free admission capacity. Multi-step fence
    // fixtures retain their token by default; borrowed claims stay with their caller.
    if (options.releaseClaim && !existing)
      await releaseExternalClaim(db, claim);
  }
}

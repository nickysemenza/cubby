import type { RecipeId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  backgroundTaskMessageSchema,
  type BackgroundTaskMessage,
} from "@cubby/schemas/queue-messages";
import { releaseId, usdaReleaseObjectName } from "@cubby/usda/release";
import { fromPartial } from "@total-typescript/shoehorn";

import { setCfEnv } from "~/server/cf-env";
import { getUsdaReleaseEnv } from "~/server/cf-env";
import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { entityStoredDerivedDeclarations } from "~/server/db/derived-declarations";
import { productFoodCompute } from "~/server/domains/product/repo/read-facts";
import { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import { commitRecipeTotals } from "~/server/domains/recipe/repo/totals";
import type { UsdaReleaseRpc } from "~/server/domains/usda-release/operations/rpc";
import {
  type DerivedAdapter,
  type DerivedComputes,
  derivedSink,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";
import { readSnapshotState as readDerivedRebuildStatus } from "~/server/generic/derived/repo/snapshot-state";
import { runSnapshotPage } from "~/server/generic/derived/snapshot.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { prepareProductConversionCoverage } from "~/server/generic/problems/service/problems.service";
import { derivedComputes } from "~/server/workflows/derived-computes";

/** Database-only journeys have no Worker binding; configured USDA fixtures retain their exact port. */
const fixtureUsda = () => {
  const env = getUsdaReleaseEnv();
  return new USDAClient(
    env?.USDA_RELEASE && env.USDA_ACTIVE_RELEASE
      ? env.USDA_RELEASE.getByName(
          usdaReleaseObjectName(releaseId.parse(env.USDA_ACTIVE_RELEASE)),
          { locationHint: "wnam" },
        )
      : fromPartial<UsdaReleaseRpc>({
          lookupBatch: async (lookups: readonly unknown[]) =>
            lookups.map(() => null),
          search: async () => ({ data: [], count: 0 }),
        }),
  );
};
const fixtureComputes: DerivedComputes = {
  ...derivedComputes,
  "product.food": (db, ids) =>
    productFoodCompute({
      findFoodsBatch: (lookups) => fixtureUsda().findFoodsBatch(lookups),
    })(db, ids),
  "product.conversionCoverage": derivedSink({
    prepare: (db, ids) =>
      prepareProductConversionCoverage(
        db,
        ids.map((id) => parseEntityId("product", id)),
        fixtureUsda(),
      ),
    publish: async (tx, ids, prepared) => {
      await prepared.publish(tx, ids);
    },
  }),
  "recipe.totals": derivedSink({
    prepare: (db, ids) =>
      new RecipeCostingService(db, {
        findFoodsBatch: (lookups) => fixtureUsda().findFoodsBatch(lookups),
      }).computeStoredTotals(ids.map((id) => parseEntityId("recipe", id))),
    publish: async (tx, ids, totals) => {
      await commitRecipeTotals(tx, {
        updates: ids.flatMap((id) => {
          const value = totals.get(id);
          return value
            ? [{ id: parseEntityId("recipe", id), totals: value }]
            : [];
        }),
        freshOnlyIds: [],
      });
    },
  }),
};

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

/** Run the same bounded pass as the Worker; retained tickets are never a completion signal. */
export async function drainStoredDerived(
  db: Database,
  maxPages = 1_000,
  computes: DerivedComputes = fixtureComputes,
): Promise<void> {
  // Finish an interrupted fixture cycle, then rebuild current inputs from its first phase.
  const rounds = (await readDerivedRebuildStatus(db)).running ? 2 : 1;
  for (let round = 0; round < rounds; round++) {
    let finished = false;
    for (let page = 0; page < maxPages; page++) {
      if (!(await runSnapshotPage(db, computes, { force: page === 0 }))) {
        finished = true;
        break;
      }
    }
    if (!finished)
      throw new Error(
        `Deterministic fixture rebuild exceeded ${maxPages} pages`,
      );
  }
}

/** A source edit during preparation may publish mixed-age output; the next pass repairs it. */
export async function drainDerivedPage(
  db: Database,
  {
    target,
    during,
    computes = fixtureComputes,
  }: {
    target?: string;
    during?: () => Promise<void>;
    computes?: DerivedComputes;
  } = {},
): Promise<void> {
  let pending = during;
  const selected = target
    ? entityStoredDerivedDeclarations().find((entry) => entry.target === target)
        ?.compute
    : undefined;
  const after = async <T>(key: string, read: Promise<T>) => {
    const result = await read;
    if (pending && (!selected || selected === key)) {
      const run = pending;
      pending = undefined;
      await run();
    }
    return result;
  };
  const observed = Object.fromEntries(
    Object.entries(computes).map(([key, adapter]): [string, DerivedAdapter] =>
      isDerivedSink(adapter)
        ? [
            key,
            {
              ...adapter,
              prepare: (db, ids) => after(key, adapter.prepare(db, ids)),
            },
          ]
        : [
            key,
            Object.assign(
              (db: Parameters<typeof adapter>[0], ids: readonly string[]) =>
                after(key, adapter(db, ids)),
              { preparationBatchSize: adapter.preparationBatchSize },
            ),
          ],
    ),
  );
  for (let page = 0; page < 1_000; page++) {
    const more = await runSnapshotPage(db, observed, { force: page === 0 });
    if (!pending) return;
    if (!more) break;
  }
  if (pending) throw new Error("The selected derived preparation did not run");
}

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
      await commitRecipeTotals(tx, { updates, freshOnlyIds: [] });
    },
  });
  return drainStoredDerived(db, maxPages, {
    ...fixtureComputes,
    "recipe.totals": recipeSink,
  });
}

/** Exercise broad catch-up: mark every stored value, then drain. */
export async function reconcileDerivedRefreshInputs(
  db: Database,
): Promise<void> {
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

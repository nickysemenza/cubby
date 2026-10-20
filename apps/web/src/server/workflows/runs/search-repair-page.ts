import type { SearchRepairPendingSource } from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import { recordDatabaseWrite } from "~/server/db/freshness/client";
import {
  applySearchIndexRepairSourcePage,
  publishSearchIndexRepairSourcePage,
  createSearchIndexRepairCounters,
  foldSearchIndexRepairCounters,
} from "~/server/generic/search/service/search-index-repair.service";

import {
  isWorkflowInterrupted,
  withWorkflowDeploymentEffect,
} from "./execution";
import { BOOKKEEPING_RETRIES, type DurableSteps } from "./step";

/** A selected page outlives projection changes and uncertain step acknowledgments. */
export async function runSearchRepairSourcePage(input: {
  name: string;
  requestedAt: string;
  pending: SearchRepairPendingSource;
  identity: { version: string; epoch: number };
  steps: DurableSteps;
  database<T>(work: (db: Database) => Promise<T>): Promise<T>;
}) {
  let pending = input.pending;
  const effect = (name: string, work: (db: Database) => Promise<number>) =>
    input.steps.do(`${input.name}.${name}`, BOOKKEEPING_RETRIES, async () => {
      try {
        return await input.database(async (db) => {
          const result = await withWorkflowDeploymentEffect(
            db,
            input.identity,
            work,
          );
          await recordDatabaseWrite(`search-index-repair.sources.${name}`);
          return result;
        });
      } catch (error) {
        if (isWorkflowInterrupted(error)) return null;
        throw error;
      }
    });
  if (pending.stage === "apply") {
    const applied = await effect(
      "apply",
      async (db) =>
        (await applySearchIndexRepairSourcePage(db, pending.page.refs)).rebuilt,
    );
    if (applied === null) return { kind: "interrupted" as const, pending };
    pending = { stage: "publish", page: pending.page, rebuilt: applied };
  }
  const published = await effect(
    "publish",
    async (db) =>
      (
        await publishSearchIndexRepairSourcePage(
          db,
          pending.page.refs,
          input.requestedAt,
        )
      ).published,
  );
  if (published === null) return { kind: "interrupted" as const, pending };
  return {
    kind: "done" as const,
    nextCursor: pending.page.nextCursor,
    delta: foldSearchIndexRepairCounters(
      foldSearchIndexRepairCounters(
        foldSearchIndexRepairCounters(
          createSearchIndexRepairCounters(),
          pending.page.delta,
        ),
        { rebuilt: pending.rebuilt },
      ),
      { published },
    ),
  };
}

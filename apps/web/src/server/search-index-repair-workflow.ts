import {
  searchIndexRepairCountersSchema,
  type SearchIndexRepairCounters,
  type SearchIndexRepairEvent,
} from "@cubby/schemas/maintenance";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { setCfEnv } from "~/server/cf-env";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { db, withRequestDbClient, type Database } from "~/server/db";
import type { SearchDocumentCursor } from "~/server/repo/search-document";
import {
  applySearchIndexRepairOrphanPage,
  applySearchIndexRepairSourcePage,
  createSearchIndexRepairCounters,
  foldSearchIndexRepairCounters,
  publishSearchIndexRepairSourcePage,
  SEARCH_INDEX_REPAIR_PAGE_SIZE,
  selectSearchIndexRepairOrphanPage,
  selectSearchIndexRepairSourcePage,
} from "~/server/services/search-index-repair.service";
import { withInvocationTrace } from "~/server/tracing";
import type { SearchIndexRepairWorkflowParams } from "~/server/worker-bindings";

const RETRIES = {
  retries: { limit: 3, delay: "1 second", backoff: "exponential" as const },
} as const;

const progress = (
  phase: "orphans" | "sources",
  counters: SearchIndexRepairCounters,
  more: boolean,
  pageSize: number,
): SearchIndexRepairEvent => ({
  type: "progress",
  phase,
  done: counters.scanned,
  total: counters.scanned + (more ? pageSize : 0),
  counters: { ...counters },
});

const withFreshDb = async <T>(env: Env, run: (db: Database) => Promise<T>) =>
  withRequestDbClient(env.HYPERDRIVE.connectionString, () => run(db));

/**
 * `SearchIndexRepairWorkflow`'s run (`server/worker-entrypoints.ts`). All
 * database state is resolved per step.
 */
export function runSearchIndexRepairWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<SearchIndexRepairWorkflowParams>>,
  step: WorkflowStep,
): Promise<SearchIndexRepairCounters> {
  return withInvocationTrace(
    "search-index-repair.run",
    async () => {
      // Workflow invocations may resume in a fresh isolate. Set the binding
      // bridge before any page step publishes queue work or records freshness.
      setCfEnv(env);
      let counters = createSearchIndexRepairCounters();
      let cursor: SearchDocumentCursor | null = null;
      let page = 0;

      while (true) {
        const selection = await step.do(
          `search-index-repair.orphans.select.${page}`,
          RETRIES,
          () =>
            withFreshDb(env, (db) =>
              selectSearchIndexRepairOrphanPage(db, cursor ?? undefined),
            ),
        );
        const delta = await step.do(
          `search-index-repair.orphans.apply.${page}`,
          RETRIES,
          () =>
            withFreshDb(env, async (db) => {
              const result = await applySearchIndexRepairOrphanPage(
                db,
                selection.refs,
              );
              await recordDatabaseWrite("search-index-repair.orphans");
              return result;
            }),
        );
        counters = foldSearchIndexRepairCounters(
          foldSearchIndexRepairCounters(counters, selection.delta),
          delta,
        );
        await step.do(
          `search-index-repair.orphans.progress.${page}`,
          RETRIES,
          () =>
            Promise.resolve(
              progress(
                "orphans",
                counters,
                selection.nextCursor !== null,
                SEARCH_INDEX_REPAIR_PAGE_SIZE,
              ),
            ),
        );
        cursor = selection.nextCursor;
        page += 1;
        if (cursor === null) break;
      }

      cursor = null;
      page = 0;
      while (true) {
        const selection = await step.do(
          `search-index-repair.sources.select.${page}`,
          RETRIES,
          () =>
            withFreshDb(env, (db) =>
              selectSearchIndexRepairSourcePage(db, cursor ?? undefined),
            ),
        );
        const delta = await step.do(
          `search-index-repair.sources.apply.${page}`,
          RETRIES,
          () =>
            withFreshDb(env, async (db) => {
              const result = await applySearchIndexRepairSourcePage(
                db,
                selection.refs,
              );
              await recordDatabaseWrite("search-index-repair.sources");
              return result;
            }),
        );
        counters = foldSearchIndexRepairCounters(
          foldSearchIndexRepairCounters(counters, selection.delta),
          delta,
        );
        const published = await step.do(
          `search-index-repair.sources.publish.${page}`,
          RETRIES,
          () =>
            withFreshDb(env, async (db) => {
              const result = await publishSearchIndexRepairSourcePage(
                db,
                selection.refs,
                event.payload.requestedAt,
              );
              await recordDatabaseWrite("search-index-repair.sources.publish");
              return result;
            }),
        );
        counters = foldSearchIndexRepairCounters(counters, published);
        await step.do(
          `search-index-repair.sources.progress.${page}`,
          RETRIES,
          () =>
            Promise.resolve(
              progress(
                "sources",
                counters,
                selection.nextCursor !== null,
                SEARCH_INDEX_REPAIR_PAGE_SIZE,
              ),
            ),
        );
        cursor = selection.nextCursor;
        page += 1;
        if (cursor === null) break;
      }

      return searchIndexRepairCountersSchema.parse(counters);
    },
    { "cubby.workload": "workflow", "cubby.workflow.id": event.instanceId },
  );
}

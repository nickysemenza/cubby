import {
  searchIndexRepairCountersSchema,
  type SearchIndexRepairCounters,
  type SearchIndexRepairEvent,
} from "@cubby/schemas/maintenance";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { setCfEnv } from "~/server/cf-env";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { withRequestDbClient, type Database } from "~/server/db";
import type { SearchDocumentCursor } from "~/server/repo/search-document";

interface SearchIndexRepairWorkflowParams {
  readonly requestedAt: string;
}

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
  withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
    const { db } = await import("~/server/db");
    return run(db);
  });

/** Cloudflare's durable entrypoint. All database state is resolved per step. */
export class SearchIndexRepairWorkflow extends WorkflowEntrypoint<
  Env,
  SearchIndexRepairWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<SearchIndexRepairWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<SearchIndexRepairCounters> {
    // Workflow invocations may resume in a fresh isolate. Set the binding
    // bridge before any page step publishes queue work or records freshness.
    setCfEnv(this.env);
    const {
      applySearchIndexRepairOrphanPage,
      applySearchIndexRepairSourcePage,
      createSearchIndexRepairCounters,
      foldSearchIndexRepairCounters,
      publishSearchIndexRepairSourcePage,
      SEARCH_INDEX_REPAIR_PAGE_SIZE,
      selectSearchIndexRepairOrphanPage,
      selectSearchIndexRepairSourcePage,
    } = await import("~/server/services/search-index-repair.service");
    let counters = createSearchIndexRepairCounters();
    let cursor: SearchDocumentCursor | null = null;
    let page = 0;

    while (true) {
      const selection = await step.do(
        `search-index-repair.orphans.select.${page}`,
        RETRIES,
        () =>
          withFreshDb(this.env, (db) =>
            selectSearchIndexRepairOrphanPage(db, cursor ?? undefined),
          ),
      );
      const delta = await step.do(
        `search-index-repair.orphans.apply.${page}`,
        RETRIES,
        () =>
          withFreshDb(this.env, async (db) => {
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
          withFreshDb(this.env, (db) =>
            selectSearchIndexRepairSourcePage(db, cursor ?? undefined),
          ),
      );
      const delta = await step.do(
        `search-index-repair.sources.apply.${page}`,
        RETRIES,
        () =>
          withFreshDb(this.env, async (db) => {
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
          withFreshDb(this.env, async (db) => {
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
  }
}

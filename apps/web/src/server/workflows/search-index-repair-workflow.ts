import {
  searchIndexRepairCountersSchema,
  type SearchIndexRepairCounters,
  type SearchIndexRepairEvent,
  searchRepairCheckpoint,
  type SearchRepairCheckpoint,
  type SearchRepairContinuation,
} from "@cubby/schemas/maintenance";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { setCfEnv } from "~/server/cf-env";
import { withInvocationDb, type Database } from "~/server/db";
import { recordDatabaseWrite } from "~/server/db/freshness/client";
import type { SearchDocumentCursor } from "~/server/generic/search/repo/search-document";
import { withInvocationTrace } from "~/server/observability/tracing";
import type {
  SearchIndexRepairWorkflow as SearchIndexRepairEntrypoint,
  SearchIndexRepairWorkflowParams,
} from "~/server/worker-bindings";

import { enqueueBackgroundTask } from "./background-tasks/publish";
import { workflowDeploymentBoundary } from "./deployment-boundary";
import { readWorkflowDeployment } from "./runs/activation";
import {
  isWorkflowInterrupted,
  withWorkflowDeploymentEffect,
} from "./runs/execution";
import { runSearchRepairSourcePage } from "./runs/search-repair-page";

const REPAIR_PAGES_PER_INSTANCE = 128;

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
  withInvocationDb(env.HYPERDRIVE.connectionString, async () => {
    const { db } = await import("~/server/db");
    return run(db);
  });

/** Cloudflare's durable entrypoint. All database state is resolved per step. */
export class SearchIndexRepairWorkflow
  extends WorkflowEntrypoint<Env, SearchIndexRepairWorkflowParams>
  implements SearchIndexRepairEntrypoint
{
  async run(
    event: Readonly<WorkflowEvent<SearchIndexRepairWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<SearchIndexRepairCounters | SearchRepairContinuation> {
    return withInvocationTrace(
      "search-index-repair.run",
      async () => {
        // Workflow invocations may resume in a fresh isolate. Set the binding
        // bridge before any page step publishes queue work or records freshness.
        setCfEnv(this.env);
        const {
          applySearchIndexRepairOrphanPage,
          createSearchIndexRepairCounters,
          foldSearchIndexRepairCounters,
          SEARCH_INDEX_REPAIR_PAGE_SIZE,
          selectSearchIndexRepairOrphanPage,
          selectSearchIndexRepairSourcePage,
        } =
          await import("~/server/generic/search/service/search-index-repair.service");
        const checkpoint = event.payload.checkpoint
          ? searchRepairCheckpoint.parse(event.payload.checkpoint)
          : undefined;
        let counters =
          checkpoint?.counters ?? createSearchIndexRepairCounters();
        let cursor: SearchDocumentCursor | null =
          checkpoint?.phase === "orphans" ? checkpoint.cursor : null;
        let page = 0;
        let completedPages = 0;
        let pendingSource = checkpoint?.pendingSource;
        const epoch = await step.do("deployment epoch", RETRIES, () =>
          withFreshDb(this.env, async (db) => {
            const activation = await readWorkflowDeployment(db);
            if (!activation)
              throw new Error("Workflow deployment has not been activated");
            return event.payload.activationEpoch ?? activation.epoch;
          }),
        );
        const nextInstanceId = await sha256Hex(`${event.instanceId}:continue`);
        const boundary = (
          phase: SearchRepairCheckpoint["phase"],
          force = false,
        ) =>
          workflowDeploymentBoundary(step, {
            name: `${phase}:${page}`,
            version: this.env.CF_VERSION_METADATA.id,
            epoch,
            currentVersion: () =>
              withFreshDb(this.env, async (db) => {
                const activation = await readWorkflowDeployment(db);
                if (!activation)
                  throw new Error("Workflow deployment has not been activated");
                return {
                  version: activation.workerVersion,
                  epoch: activation.epoch,
                };
              }),
            force: force || completedPages >= REPAIR_PAGES_PER_INSTANCE,
            continue: async () => {
              await enqueueBackgroundTask(
                {
                  kind: "search-repair.continue",
                  requestedAt: new Date().toISOString(),
                  id: nextInstanceId,
                  params: {
                    requestedAt: event.payload.requestedAt,
                    checkpoint: {
                      phase,
                      cursor,
                      counters,
                      ...(pendingSource && { pendingSource }),
                    },
                  },
                },
                {
                  source: "search-repair.continue",
                  queue: this.env.BACKGROUND_QUEUE,
                },
              );
            },
          });
        const orphanEffect = (
          name: string,
          work: (
            db: Database,
          ) => Promise<Pick<SearchIndexRepairCounters, "retired">>,
        ) =>
          step.do(name, RETRIES, async () => {
            try {
              return await withFreshDb(this.env, (db) =>
                withWorkflowDeploymentEffect(
                  db,
                  { version: this.env.CF_VERSION_METADATA.id, epoch },
                  work,
                ),
              );
            } catch (error) {
              // Return a durable interruption marker rather than retrying old code.
              if (isWorkflowInterrupted(error)) return null;
              throw error;
            }
          });

        if (checkpoint?.phase !== "sources") {
          while (true) {
            if (await boundary("orphans")) return { nextInstanceId };
            const selection = await step.do(
              `search-index-repair.orphans.select.${page}`,
              RETRIES,
              () =>
                withFreshDb(this.env, (db) =>
                  selectSearchIndexRepairOrphanPage(db, cursor ?? undefined),
                ),
            );
            const delta = await orphanEffect(
              `search-index-repair.orphans.apply.${page}`,
              async (db) => {
                const result = await applySearchIndexRepairOrphanPage(
                  db,
                  selection.refs,
                );
                await recordDatabaseWrite("search-index-repair.orphans");
                return result;
              },
            );
            if (delta === null) {
              await boundary("orphans", true);
              return { nextInstanceId };
            }
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
            completedPages += 1;
            if (cursor === null) break;
          }
        }
        cursor = checkpoint?.phase === "sources" ? checkpoint.cursor : null;
        page = 0;
        while (true) {
          if (await boundary("sources")) return { nextInstanceId };
          const selection = await step.do(
            `search-index-repair.sources.select.${page}`,
            RETRIES,
            () =>
              pendingSource
                ? Promise.resolve(pendingSource.page)
                : withFreshDb(this.env, (db) =>
                    selectSearchIndexRepairSourcePage(db, cursor ?? undefined),
                  ),
          );
          const result = await runSearchRepairSourcePage({
            name: `search-index-repair.sources.${page}`,
            requestedAt: event.payload.requestedAt,
            pending: pendingSource ?? { stage: "apply", page: selection },
            identity: { version: this.env.CF_VERSION_METADATA.id, epoch },
            steps: step,
            database: (work) => withFreshDb(this.env, work),
          });
          if (result.kind === "interrupted") {
            pendingSource = result.pending;
            await boundary("sources", true);
            return { nextInstanceId };
          }
          pendingSource = undefined;
          counters = foldSearchIndexRepairCounters(counters, result.delta);
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
          completedPages += 1;
          if (cursor === null) break;
        }

        return searchIndexRepairCountersSchema.parse(counters);
      },
      { "cubby.workload": "workflow", "cubby.workflow.id": event.instanceId },
    );
  }
}

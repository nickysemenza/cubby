import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { setCfEnv } from "~/server/cf-env";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { db, withRequestDbClient, type Database } from "~/server/db";
import {
  beginMailDiscovery,
  continueMailDiscovery,
  failMailDiscovery,
  finishMailDiscovery,
  listMailDiscovery,
  saveMailDiscoveryBatch,
} from "~/server/purchase-import/gmail/discovery";
import {
  runMailDiscovery,
  runVendorMailSearch,
} from "~/server/purchase-import/gmail/mail-workflows";
import {
  beginVendorMailSearchAttempt,
  failVendorMailSearch,
  scanVendorMailPage,
} from "~/server/purchase-import/gmail/search-job";
import { withInvocationTrace } from "~/server/tracing";
import type { WorkflowRunParams } from "~/server/workflow-runs/contract";
import type { DurableSteps } from "~/server/workflow-runs/step";

/**
 * Every step opens its own database client — a Hyperdrive connection must
 * not outlive the step that opened it — and records the write so cached
 * reads see the Run's new progress.
 */
const stepDb =
  (env: Env, source: string) =>
  async <T>(work: (db: Database) => Promise<T>): Promise<T> =>
    withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
      const result = await work(db);
      await recordDatabaseWrite(source);
      return result;
    });

const durableSteps = (step: WorkflowStep): DurableSteps => ({
  do: (name, config, callback) => step.do(name, config, callback),
  sleep: (name, durationMs) => step.sleep(name, durationMs),
});

/**
 * `VendorMailSearchWorkflow` (`server/worker-entrypoints.ts`): walks one
 * `mail_search` Run's Gmail pages (see `gmail/mail-workflows.ts`).
 */
export function runVendorMailSearchWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<WorkflowRunParams>>,
  step: WorkflowStep,
): Promise<{ runId: string }> {
  return withInvocationTrace(
    "vendor-mail-search.run",
    async () => {
      // A Workflow invocation may resume in a fresh isolate.
      setCfEnv(env);
      const params = event.payload;
      const withDb = stepDb(env, "vendor-mail-search");
      await runVendorMailSearch(durableSteps(step), {
        begin: () => withDb((db) => beginVendorMailSearchAttempt(db, params)),
        scanPage: (page) =>
          withDb((db) => scanVendorMailPage(db, params, page)),
        fail: (stepError) =>
          withDb(async (db) => {
            await failVendorMailSearch(db, params, stepError);
            return null;
          }),
      });
      return { runId: params.runId };
    },
    { "cubby.workload": "workflow", "cubby.workflow.id": event.instanceId },
  );
}

/**
 * `MailDiscoveryWorkflow` (`server/worker-entrypoints.ts`): runs one scheduled
 * `mail_discovery` pass (see `gmail/discovery.ts`).
 */
export function runMailDiscoveryWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<WorkflowRunParams>>,
  step: WorkflowStep,
): Promise<{ runId: string }> {
  return withInvocationTrace(
    "mail-discovery.run",
    async () => {
      setCfEnv(env);
      const params = event.payload;
      const withDb = stepDb(env, "mail-discovery");
      await runMailDiscovery(durableSteps(step), {
        begin: () => withDb((db) => beginMailDiscovery(db, params)),
        list: () => withDb((db) => listMailDiscovery(db, params)),
        batch: (index) =>
          withDb((db) => saveMailDiscoveryBatch(db, params, index)),
        finish: () => withDb((db) => finishMailDiscovery(db, params)),
        continue: () => withDb((db) => continueMailDiscovery(db, params)),
        fail: (stepError) =>
          withDb((db) => failMailDiscovery(db, params, stepError)),
      });
      return { runId: params.runId };
    },
    { "cubby.workload": "workflow", "cubby.workflow.id": event.instanceId },
  );
}

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { setCfEnv } from "~/server/cf-env";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { withRequestDbClient, type Database } from "~/server/db";
import { withInvocationTrace } from "~/server/tracing";
import type { MailDiscoveryWorkflow as MailDiscoveryEntrypoint } from "~/server/worker-bindings";
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
      const { db } = await import("~/server/db");
      const result = await work(db);
      await recordDatabaseWrite(source);
      return result;
    });

const durableSteps = (step: WorkflowStep): DurableSteps => ({
  do: (name, config, callback) => step.do(name, config, callback),
  sleep: (name, durationMs) => step.sleep(name, durationMs),
});

/** Runs one scheduled `mail_discovery` pass (see `gmail/discovery.ts`). */
export class MailDiscoveryWorkflow
  extends WorkflowEntrypoint<Env, WorkflowRunParams>
  implements MailDiscoveryEntrypoint
{
  async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ): Promise<{ runId: string }> {
    return withInvocationTrace(
      "mail-discovery.run",
      async () => {
        setCfEnv(this.env);
        const params = event.payload;
        const withDb = stepDb(this.env, "mail-discovery");
        const [
          { runMailDiscovery },
          {
            beginMailDiscovery,
            listMailDiscovery,
            saveMailDiscoveryBatch,
            finishMailDiscovery,
            continueMailDiscovery,
            failMailDiscovery,
          },
        ] = await Promise.all([
          import("~/server/purchase-import/gmail/mail-workflows"),
          import("~/server/purchase-import/gmail/discovery"),
        ]);
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
}

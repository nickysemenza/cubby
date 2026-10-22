import { createLogger } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/cloudflare";

import { TELEMETRY_SCHEMA_VERSION } from "~/lib/http-cache";
import { withCfEnv } from "~/server/cf-env";
import { db, withInvocationDb } from "~/server/db";
import { isMaintenanceMode } from "~/server/http/maintenance";
import { withInvocationTrace, withTrace } from "~/server/observability/tracing";
import { CRON_SCHEDULES } from "~/server/worker-identity";
const cronLog = createLogger("cron");

export async function handleScheduledInvocation(
  controller: { scheduledTime: number; cron: string },
  env: Env,
) {
  return withCfEnv(env, () =>
    withInvocationTrace(
      "cf.scheduled",
      async () => {
        if (isMaintenanceMode(env)) {
          cronLog.warn("skipped: maintenance mode");
          return;
        }
        if (controller.cron === CRON_SCHEDULES.backgroundRecovery) {
          await withInvocationDb(env.HYPERDRIVE.connectionString, async () => {
            const { recoverMissedWork } =
              await import("~/server/workflows/catch-up");
            await recoverMissedWork(db);
          });
          return;
        }
        if (controller.cron !== CRON_SCHEDULES.dailyMaintenance)
          throw new Error(`Unexpected cron trigger: ${controller.cron}`);
        await Sentry.withMonitor(
          "daily-maintenance",
          async () => {
            // Launch durable maintenance work; Jobs drain its backlog separately.
            await withInvocationDb(
              env.HYPERDRIVE.connectionString,
              async () => {
                const [
                  { launchMaintenanceRun },
                  { systemActor },
                  { recoverMissedWork },
                ] = await Promise.all([
                  import("~/server/domains/maintenance/service/maintenance.service"),
                  import("~/server/domains/run/repo/ensure-run"),
                  import("~/server/workflows/catch-up"),
                ]);
                const jobs = await Promise.allSettled([
                  withTrace(
                    "cf.scheduled.job",
                    async (span) => {
                      const launched = await launchMaintenanceRun(
                        db,
                        systemActor(),
                        "scheduled",
                      );
                      span.setAttributes({
                        "cubby.maintenance.run": launched.runId,
                        "cubby.maintenance.existing": launched.existing,
                      });
                    },
                    { "cubby.scheduled.job": "maintenance-run" },
                  ),
                  withTrace("cf.scheduled.job", () => recoverMissedWork(db), {
                    "cubby.scheduled.job": "recover-missed-work",
                  }),
                ]);
                const failures = jobs.filter(
                  (job) => job.status === "rejected",
                );
                for (const job of failures) Sentry.captureException(job.reason);
                if (failures.length)
                  throw new AggregateError(
                    failures.map((job) => job.reason),
                    "Daily maintenance failed",
                  );
              },
            );
          },
          {
            schedule: {
              type: "crontab",
              value: CRON_SCHEDULES.dailyMaintenance,
            },
            checkinMargin: 10,
            maxRuntime: 30,
            timezone: "Etc/UTC",
            failureIssueThreshold: 1,
            recoveryThreshold: 1,
          },
        );
      },
      {
        "cubby.workload": "scheduled",
        "cloudflare.cron": controller.cron,
        "cloudflare.scheduled_time": controller.scheduledTime,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    ),
  );
}

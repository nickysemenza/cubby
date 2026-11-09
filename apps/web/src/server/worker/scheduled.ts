import { systemActor } from "@cubby/schemas/context";
import { createLogger } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/cloudflare";

import { TELEMETRY_SCHEMA_VERSION } from "~/lib/http-cache";
import { getSourceRelease, withCfEnv } from "~/server/cf-env";
import { db, withInvocationDb } from "~/server/db";
import { isMaintenanceMode } from "~/server/http/maintenance";
import { withInvocationTrace, withTrace } from "~/server/observability/tracing";
import { CRON_SCHEDULES } from "~/server/worker-identity";
const cronLog = createLogger("cron");

/**
 * The timer and backstop for every wake: one drain of whatever is due, run here
 * rather than sent through the queue, so a dropped or failed wake recovers within
 * the hour even while delivery itself is broken, and parked device work that came
 * due gets its ring. A failure still lets the daily
 * pass run, then rejects the event.
 */
async function runHourlyBackstop(
  env: Env,
): Promise<{ failed: false } | { failed: true; error: unknown }> {
  try {
    await withInvocationDb(
      env.HYPERDRIVE_BACKGROUND.connectionString,
      async () => {
        const [
          { drainProductionJobs },
          { ringDueDeviceWork },
          { publishAiRefreshActivation },
        ] = await Promise.all([
          import("~/server/workflows/jobs"),
          import("~/server/domains/image-processing/repo/image-processing-ring"),
          import("~/server/workflows/ai-refresh-startup"),
        ]);
        await withTrace(
          "cf.scheduled.job",
          async () => {
            // The first tick after a deploy activates that version's AI policy.
            // A failure here must not stop the drain; the next tick tries again.
            await publishAiRefreshActivation(
              db,
              env.CF_VERSION_METADATA.id,
              getSourceRelease(env).commit,
            ).catch((error: unknown) => Sentry.captureException(error));
            await ringDueDeviceWork(db);
            const steps = await Promise.allSettled([
              drainProductionJobs(db),
              (await import("~/server/workflows/job-maintenance")).maintainJobs(
                db,
              ),
            ]);
            const errors = steps.flatMap((step) =>
              step.status === "rejected" ? [step.reason] : [],
            );
            if (errors.length)
              throw new AggregateError(errors, "Hourly background work failed");
          },
          { "cubby.scheduled.job": "hourly-backstop" },
        );
      },
    );
    return { failed: false };
  } catch (error) {
    Sentry.captureException(error);
    return { failed: true, error };
  }
}

/** The occurrence's date in the household's zone, which a retry of it shares. */
const householdDateOf = (instant: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);

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
        if (controller.cron !== CRON_SCHEDULES.hourly)
          throw new Error(`Unexpected cron trigger: ${controller.cron}`);
        const backstop = await runHourlyBackstop(env);
        const instant = new Date(controller.scheduledTime);
        const hour = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "numeric",
          hourCycle: "h23",
        }).format(instant);
        if (hour !== "07" && hour !== "7") {
          if (backstop.failed) throw backstop.error;
          return;
        }
        await Sentry.withMonitor(
          "daily-maintenance",
          async () => {
            // The cron only launches the pass; its steps drain each backlog
            // page by page through run.execute Jobs, one active pass at a time.
            await withInvocationDb(
              env.HYPERDRIVE_BACKGROUND.connectionString,
              async () => {
                const [{ launchMaintenanceRun }, { recoverMissedWork }] =
                  await Promise.all([
                    import("~/server/domains/maintenance/service/maintenance.service"),
                    import("~/server/workflows/catch-up"),
                  ]);
                const jobs = await Promise.allSettled([
                  withTrace(
                    "cf.scheduled.job",
                    async (span) => {
                      const launched = await launchMaintenanceRun(
                        db,
                        systemActor(),
                        { householdDate: householdDateOf(instant) },
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
              value: "0 7 * * *",
            },
            checkinMargin: 10,
            maxRuntime: 30,
            timezone: "America/Los_Angeles",
            failureIssueThreshold: 1,
            recoveryThreshold: 1,
          },
        );
        if (backstop.failed) throw backstop.error;
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

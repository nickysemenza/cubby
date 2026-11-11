import { systemActor } from "@cubby/schemas/context";
import { BACKGROUND_QUEUE_CONSUMER } from "@cubby/shared/background-queue";
import { createLogger } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/cloudflare";

import { TELEMETRY_SCHEMA_VERSION } from "~/lib/http-cache";
import { getSourceRelease, withCfEnv } from "~/server/cf-env";
import { db, withInvocationDb } from "~/server/db";
import { isMaintenanceMode } from "~/server/http/maintenance";
import { withInvocationTrace, withTrace } from "~/server/observability/tracing";
import { CRON_SCHEDULES } from "~/server/worker-identity";

import { forwardToPlaced } from "./placed";

const cronLog = createLogger("cron");

/** Units the cron runs itself before handing the rest to queue permits. */
const BACKSTOP_BUDGET_MS = 5 * 60_000;

/**
 * The timer and backstop for every permit: work due past the queue's 12-hour
 * delay, a lost permit, or broken delivery. It reconciles, maintains, then runs
 * units itself (so a broken queue still drains within the hour), and finally
 * sends up to `maxConcurrency` permits for what is still due. Parked device
 * work that came due gets its ring. A failure still lets the daily pass run,
 * then rejects the event.
 */
async function runHourlyBackstop(
  env: Env,
): Promise<{ failed: false } | { failed: true; error: unknown }> {
  try {
    await withInvocationDb(
      env.HYPERDRIVE_BACKGROUND.connectionString,
      async () => {
        const [
          { productionPermitRuntime, reconcileStoppedWork },
          { runPermit, sendSuccessor },
          { ringDueDeviceWork },
          { publishAiRefreshActivation },
          { maintainJobs },
        ] = await Promise.all([
          import("~/server/workflows/jobs"),
          import("~/server/generic/jobs/service/permits"),
          import("~/server/domains/image-processing/repo/image-processing-ring"),
          import("~/server/workflows/ai-refresh-startup"),
          import("~/server/workflows/job-maintenance"),
        ]);
        await withTrace(
          "cf.scheduled.job",
          async () => {
            // The first tick after a deploy activates that version's AI policy.
            // A failure here must not stop the backstop; the next tick tries again.
            await publishAiRefreshActivation(
              db,
              env.CF_VERSION_METADATA.id,
              getSourceRelease(env).commit,
            ).catch((error: unknown) => Sentry.captureException(error));
            await ringDueDeviceWork(db);
            const errors: unknown[] = [];
            for (const step of [reconcileStoppedWork, maintainJobs])
              await step(db).catch((error: unknown) => errors.push(error));
            const runtime = productionPermitRuntime(db, (error, unit) =>
              Sentry.withScope((scope) => {
                if (unit) scope.setTag("cubby.background.unit", unit);
                Sentry.captureException(error);
              }),
            );
            const deadline = Date.now() + BACKSTOP_BUDGET_MS;
            for (let ran = true; ran && Date.now() < deadline;)
              ran = (await runPermit(runtime, { successor: false })) !== null;
            await sendSuccessor(
              runtime,
              "cron.backstop",
              BACKGROUND_QUEUE_CONSUMER.maxConcurrency,
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

type ScheduledController = { scheduledTime: number; cron: string };

export async function handleScheduledInvocation(
  controller: ScheduledController,
  env: Env,
) {
  return runScheduledInvocation(controller, env, false);
}

/** The placed side of a forwarded tick; a failure answers 500 to the caller. */
export async function runPlacedScheduled(
  controller: ScheduledController,
  env: Env,
) {
  await runScheduledInvocation(controller, env, true);
  return new Response(null, { status: 204 });
}

async function runScheduledInvocation(
  controller: ScheduledController,
  env: Env,
  placed: boolean,
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
        if (
          !placed &&
          (await forwardToPlaced(env, {
            event: "scheduled",
            cron: controller.cron,
            scheduledTime: controller.scheduledTime,
          }))
        )
          return;
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
        "cubby.workload": placed ? "scheduled.placed" : "scheduled",
        "cloudflare.cron": controller.cron,
        "cloudflare.scheduled_time": controller.scheduledTime,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    ),
  );
}

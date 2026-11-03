import type { JobShortcode } from "@cubby/schemas/identifiers";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import { getAuthBindings } from "~/server/cf-env";

export const jobScheduler = () =>
  getAuthBindings()?.JOB_SCHEDULER?.getByName("household");

/** Called before execution and after settlement, never from inside a database transaction. */
export async function reconcileJobSchedule(
  cause: string,
  job?: JobShortcode,
): Promise<void> {
  const error = await jobScheduler()?.reconcile(cause, job);
  if (error) throw new Error(error);
}

/** First request after deploy bootstraps existing work once; repeated probes never read Postgres. */
export async function bootstrapJobSchedule(env: Env): Promise<void> {
  const scheduler = env.JOB_SCHEDULER?.getByName("household");
  if (!scheduler) return;
  const token = await scheduler.claimBootstrap(env.CF_VERSION_METADATA.id);
  if (!token) return;
  const { db, withInvocationDb } = await import("~/server/db");
  const { getSourceRelease } = await import("~/server/cf-env");
  try {
    await withInvocationDb(
      env.HYPERDRIVE_BACKGROUND.connectionString,
      async () => {
        const { publishAiRefreshActivation } =
          await import("~/server/workflows/ai-refresh-startup");
        await publishAiRefreshActivation(
          db,
          env.CF_VERSION_METADATA.id,
          getSourceRelease(env).commit,
        );
        await (
          await import("~/server/workflows/catch-up")
        ).recoverMissedWork(db, undefined, false);
      },
    );
    await scheduler.finishBootstrap(env.CF_VERSION_METADATA.id, token, null);
  } catch (error) {
    await scheduler.finishBootstrap(
      env.CF_VERSION_METADATA.id,
      token,
      scrubErrorMessage(JSON.stringify(describeErrorCauses(error))),
    );
    throw error;
  }
}

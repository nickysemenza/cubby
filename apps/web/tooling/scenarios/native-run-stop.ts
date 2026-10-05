import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

import { startSyntheticSyncRun } from "./native-qa";

/**
 * The ordinary-Run "see it stop" guard for the native QA lane. Native has no stop command, so
 * the server stops the Run between two journeys that share one app session: the first opens the
 * running Run's detail and sees it live, the second (no relaunch) sees the same open screen
 * report the stopped state from its own polling. Regression: a Run detail that never polled, or
 * polled a status it did not redraw, kept showing a stopped Run as running.
 */
export async function runNativeRunStopJourney(input: {
  pool: Pool;
  userId: string;
  artifacts: string;
  /** Replays one `apps/apple/e2e` journey with these `-e` variables, without relaunching. */
  replay: (journey: string, variables: Record<string, string>) => Promise<void>;
}): Promise<string> {
  const run = await startSyntheticSyncRun(input.pool, input.userId, "Stop");
  const variables = { STOP_RUN_ID: run.publicId };
  await input.replay("run-stop-live.ad", variables);
  // The same transition a household cancel makes (`controlRun` "cancel").
  const stopped = await input.pool.query<{ status: string }>(
    `UPDATE "Run" SET status = 'failed', "failureCode" = 'user_cancelled', "endedAt" = now(), "updatedAt" = now()
     WHERE shortcode = $1 AND status = 'running' RETURNING status`,
    [run.publicId],
  );
  if (stopped.rowCount !== 1)
    throw new Error(`The seeded Run ${run.publicId} was not running`);
  await input.replay("run-stop-stopped.ad", variables);
  const evidence = path.join(input.artifacts, "native-run-stop-result.json");
  writeFileSync(
    evidence,
    `${JSON.stringify(
      {
        run: run.publicId,
        purpose: "account_sync",
        transition: "running -> failed (user_cancelled), server-side",
        observed: "the open native Run detail redrew the stopped state",
      },
      null,
      2,
    )}\n`,
  );
  return evidence;
}

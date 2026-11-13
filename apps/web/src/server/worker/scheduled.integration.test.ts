import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { CRON_SCHEDULES } from "~/server/worker-identity";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

import { handleScheduledInvocation } from "./scheduled";

const ctx = withTestDb();

// Both daily jobs must be attempted and their failures must reject the event.
// A connection-local search path supplies real PostgreSQL failures without
// changing the leased database's schema or affecting other connections.
it("rejects daily completion with both independent database failures", async () => {
  const connection = new URL(ctx.databaseUrl);
  connection.searchParams.set("options", "-c search_path=pg_catalog");
  const applicationName = "synthetic-scheduled-maintenance";
  connection.searchParams.set("application_name", applicationName);
  try {
    await expect(
      handleScheduledInvocation(
        {
          scheduledTime: Date.parse("2026-01-15T15:00:00Z"),
          cron: CRON_SCHEDULES.hourly,
        },
        fromPartial<Env>({
          HYPERDRIVE_BACKGROUND: { connectionString: connection.toString() },
          CF_VERSION_METADATA: { id: "synthetic-version" },
        }),
      ),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "Daily maintenance failed",
      errors: [expect.any(Error), expect.any(Error)],
    });
  } finally {
    // Pool shutdown can finish before PostgreSQL removes its closing backend.
    // Drain only this invocation's tagged sessions before fixture reset.
    await expect
      .poll(
        async () => {
          const remaining = await getDb(ctx.db).execute<{ pid: number }>(sql`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${applicationName}
      `);
          return remaining.rows;
        },
        { timeout: 1000 },
      )
      .toEqual([]);
  }
});

// A wake sent to the queue can be lost after its intent commits. Nothing here
// delivers one: only the hourly tick can reach this Job, and it must do so
// without the daily pass, which runs at no other household hour.
it("recovers committed work whose wake was dropped within one hourly tick", async () => {
  await publishBackgroundTasks(
    ctx.db,
    [
      {
        kind: "maintenance.purchase-discovery",
        requestedAt: "2026-01-15T14:00:00.000Z",
      },
    ],
    { source: "synthetic-test" },
  );
  await handleScheduledInvocation(
    {
      scheduledTime: Date.parse("2026-01-15T14:00:00Z"),
      cron: CRON_SCHEDULES.hourly,
    },
    fromPartial<Env>({
      HYPERDRIVE_BACKGROUND: { connectionString: ctx.databaseUrl },
      CF_VERSION_METADATA: { id: "synthetic-version" },
    }),
  );
  await expect(
    getDb(ctx.db).execute(
      sql`SELECT "doneAt" FROM "Pass" WHERE name = 'purchase.discovery'`,
      "objects",
    ),
  ).resolves.toMatchObject([{ doneAt: expect.any(String) }]);
  await expect(readJobs(ctx.db, { key: "jobs.maintenance" })).resolves.toEqual(
    [],
  );
});

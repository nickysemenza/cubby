import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { workQueueHandlers } from "~/server/domains/work/operations/work-queue.server";
import { systemPrincipal } from "~/server/http/authenticate";
import { readPasses, seedPass } from "~/server/kernel/pass.fixtures";
import { CRON_SCHEDULES } from "~/server/worker-identity";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

import { handleScheduledInvocation } from "./scheduled";

const ctx = withTestDb();

const tickHourly = () =>
  handleScheduledInvocation(
    {
      scheduledTime: Date.parse("2026-01-15T14:00:00Z"),
      cron: CRON_SCHEDULES.hourly,
    },
    fromPartial<Env>({
      HYPERDRIVE_BACKGROUND: { connectionString: ctx.databaseUrl },
      CF_VERSION_METADATA: { id: "synthetic-version" },
    }),
  );

const requestPurchaseDiscovery = () =>
  publishBackgroundTasks(
    ctx.db,
    [
      {
        kind: "maintenance.purchase-discovery",
        requestedAt: "2026-01-15T14:00:00.000Z",
      },
    ],
    { source: "synthetic-test" },
  );

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
  await requestPurchaseDiscovery();
  expect(
    await readPasses(ctx.db, { name: "purchase.mailbox-discovery" }),
  ).toHaveLength(1);
  await tickHourly();
  await expect(
    getDb(ctx.db).execute(
      sql`SELECT "doneAt" FROM "Pass" WHERE name = 'purchase.discovery'`,
      "objects",
    ),
  ).resolves.toMatchObject([{ doneAt: expect.any(String) }]);
});

it("leaves spent discovery parked through the hourly tick and maintenance until Work retries it", async () => {
  const spent = { attempts: 3, maxAttempts: 3, lastError: "Synthetic failure" };
  const cursor = { censusStartedAt: "2026-01-15T13:00:00.000" };
  await seedPass(ctx.db, {
    name: "purchase.discovery",
    key: "default",
    cursor,
    ...spent,
  });
  await seedPass(ctx.db, {
    name: "email.purchase-discovery",
    key: "default",
    ...spent,
  });

  await tickHourly();
  await requestPurchaseDiscovery();
  const parked = await readPasses(ctx.db, { name: "purchase.discovery" });
  expect(parked).toMatchObject([{ ...spent, doneAt: null }]);
  expect(parked[0]?.cursor).toEqual(cursor);
  expect(
    await readPasses(ctx.db, { name: "email.purchase-discovery" }),
  ).toMatchObject([{ ...spent, doneAt: null }]);
  expect(
    await readPasses(ctx.db, { name: "purchase.mailbox-discovery" }),
  ).toEqual([]);

  await expect(
    workQueueHandlers.operations.retry({
      data: { type: "pass", kind: "purchase.discovery", key: "default" },
      request: {
        principal: systemPrincipal(
          buildKernelContext(ctx.db, ctx.actor.userId),
        ),
        headers: new Headers(),
        signal: new AbortController().signal,
      },
    }),
  ).resolves.toMatchObject({ ok: true, data: { retried: true } });
  expect(
    await readPasses(ctx.db, { name: "purchase.discovery" }),
  ).toMatchObject([{ attempts: 0, cursor, doneAt: null }]);
  expect(
    await readPasses(ctx.db, { name: "purchase.mailbox-discovery" }),
  ).toMatchObject([{ attempts: 0, doneAt: null }]);
  expect(
    await readPasses(ctx.db, { name: "email.purchase-discovery" }),
  ).toMatchObject([{ ...spent, doneAt: null }]);
});

import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { CRON_SCHEDULES } from "~/server/worker-identity";

import { handleScheduledInvocation } from "./scheduled";

const ctx = withTestDb();

// Both daily jobs must be attempted and their failures must reject the event.
// A connection-local search path supplies real PostgreSQL failures without
// changing the leased database's schema or affecting other connections.
it("rejects daily completion with both independent database failures", async () => {
  const connection = new URL(ctx.databaseUrl);
  connection.searchParams.set("options", "-c search_path=pg_catalog");
  await expect(
    handleScheduledInvocation(
      {
        scheduledTime: Date.parse("2026-01-15T15:00:00Z"),
        cron: CRON_SCHEDULES.dailyMaintenance,
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
});

it.each(["2026-01-15T14:00:00Z", "2026-07-15T15:00:00Z"])(
  "skips the non-household hour before opening Postgres (%s)",
  async (instant) => {
    await expect(
      handleScheduledInvocation(
        {
          scheduledTime: Date.parse(instant),
          cron: CRON_SCHEDULES.dailyMaintenance,
        },
        fromPartial<Env>({ CF_VERSION_METADATA: { id: "synthetic-version" } }),
      ),
    ).resolves.toBeUndefined();
  },
);

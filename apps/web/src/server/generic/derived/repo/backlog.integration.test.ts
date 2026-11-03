import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
import { getDb } from "~/server/db/helpers";
import {
  deleteWorkItems,
  insertWorkItems,
  updateJobs,
} from "~/server/generic/jobs/jobs.fixtures";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

import { readDerivedBacklog } from "./backlog";

// Failure mode: a backlog that drained between 15 s reads showed "No values
// waiting to update" while values were updating, so Activity looked idle.
const KIND = "product";
const KEY = "synthetic";

describe("derived backlog", () => {
  const ctx = withTestDb();

  it("reports recent publications per minute and the oldest waiting value", async () => {
    await deleteWorkItems(ctx.db);
    await getDb(ctx.db).execute(sql`
      WITH ages(n, minutes) AS (VALUES (1, 0), (2, 0), (3, 2), (4, 14), (5, 20)),
      entities AS (
        INSERT INTO "Entity" (id, kind, shortcode)
        SELECT gen_random_uuid(), ${KIND}, 'PRD-ZZZ' || n FROM ages
        RETURNING id, shortcode
      )
      INSERT INTO "DerivedValue" ("entityId", kind, key, value, "computedAt")
      SELECT entities.id, ${KIND}, ${KEY}, '1'::jsonb,
        now() - (ages.minutes * interval '1 minute') - interval '10 seconds'
      FROM entities JOIN ages ON entities.shortcode = 'PRD-ZZZ' || ages.n`);
    await insertWorkItems(ctx.db, [
      {
        target: `${KIND}.price`,
        ref: crypto.randomUUID(),
        dirtiedAt: sql`now() - interval '90 seconds'`,
      },
    ]);
    const runningRef = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    await enqueueJob(ctx.db, {
      key: DERIVED_DRAIN_JOB_KEY,
      kind: "derived.drain",
      input: {},
    });
    await updateJobs(
      ctx.db,
      { key: DERIVED_DRAIN_JOB_KEY },
      {
        state: "running",
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    );
    await insertWorkItems(ctx.db, [
      {
        target: `${KIND}.price`,
        ref: crypto.randomUUID(),
        readyAt: new Date(Date.now() + 30_000),
      },
      {
        target: `${KIND}.price`,
        ref: crypto.randomUUID(),
        lastError: "Synthetic prior failure",
        readyAt: new Date(Date.now() + 40_000),
      },
      { target: `${KIND}.price`, ref: runningRef },
    ]);
    await getDb(ctx.db).execute(sql`
      UPDATE "WorkItem" SET "executionLeaseToken" = ${leaseToken}::uuid,
        "executionTicket" = ticket, "executionStartedAt" = now(),
        "lastError" = 'Synthetic previous attempt failure'
      WHERE target = ${`${KIND}.price`} AND ref = ${runningRef}::uuid`);

    await getDb(ctx.db).execute(
      sql`UPDATE "WorkItem" SET reason = 'Product price changed' WHERE ref = ${runningRef}::uuid`,
    );
    const backlog = await readDerivedBacklog(ctx.db);
    const price = backlog.kinds.find(
      (kind) => kind.entity === KIND && kind.field === "price",
    );
    expect(price?.refreshReasons).toEqual(
      expect.arrayContaining([
        { reason: null, count: 3 },
        { reason: "Product price changed", count: 1 },
      ]),
    );
    expect(
      price?.refreshReasons?.reduce((sum, bucket) => sum + bucket.count, 0),
    ).toBe(price?.count);

    expect(backlog.recent.windowMinutes).toBe(15);
    expect(backlog.recent.perMinute).toHaveLength(15);
    // Oldest first: minute 14 ago leads, the current minute ends.
    expect(backlog.recent.perMinute[0]).toBe(1);
    expect(backlog.recent.perMinute[12]).toBe(1);
    expect(backlog.recent.perMinute[14]).toBe(2);
    expect(backlog.recent.perMinute.reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(backlog.oldestWaitingSeconds).toBeGreaterThanOrEqual(89);
    expect(
      backlog.kinds.find(
        (kind) => kind.entity === KIND && kind.field === "price",
      ),
    ).toMatchObject({
      count: 4,
      states: { queued: 1, running: 1, waiting: 1, failed: 1 },
      nextAttemptAt: expect.any(String),
    });
    await updateJobs(
      ctx.db,
      { key: DERIVED_DRAIN_JOB_KEY },
      {
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    );
    const expired = await readDerivedBacklog(ctx.db);
    expect(
      expired.kinds.find(
        (kind) => kind.entity === KIND && kind.field === "price",
      )?.states,
    ).toEqual({ queued: 1, running: 0, waiting: 1, failed: 2 });
  });

  it("reports no wait when nothing is queued", async () => {
    await deleteWorkItems(ctx.db);
    expect((await readDerivedBacklog(ctx.db)).oldestWaitingSeconds).toBeNull();
  });
});

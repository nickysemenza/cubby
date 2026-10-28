import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  deleteWorkItems,
  insertWorkItems,
} from "~/server/generic/jobs/jobs.fixtures";

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
        target: `${KIND}.${KEY}`,
        ref: crypto.randomUUID(),
        dirtiedAt: sql`now() - interval '90 seconds'`,
      },
    ]);

    const backlog = await readDerivedBacklog(ctx.db);

    expect(backlog.recent.windowMinutes).toBe(15);
    expect(backlog.recent.perMinute).toHaveLength(15);
    // Oldest first: minute 14 ago leads, the current minute ends.
    expect(backlog.recent.perMinute[0]).toBe(1);
    expect(backlog.recent.perMinute[12]).toBe(1);
    expect(backlog.recent.perMinute[14]).toBe(2);
    expect(backlog.recent.perMinute.reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(backlog.oldestWaitingSeconds).toBeGreaterThanOrEqual(89);
  });

  it("reports no wait when nothing is queued", async () => {
    await deleteWorkItems(ctx.db);
    expect((await readDerivedBacklog(ctx.db)).oldestWaitingSeconds).toBeNull();
  });
});

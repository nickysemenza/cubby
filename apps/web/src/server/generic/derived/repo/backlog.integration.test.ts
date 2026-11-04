import {
  ASSESSMENT_READ_RULES_VERSION,
  ASSESSMENT_READ_TARGET,
} from "@cubby/schemas/assessment-read-publication";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
import { getDb } from "~/server/db/helpers";
import { assessmentReadPublication } from "~/server/db/schema";
import { publishFieldAssessment } from "~/server/generic/assessment/repo/assessment";
import { writeAssessmentReadStage } from "~/server/generic/assessment/repo/read-publication";
import {
  deleteWorkItems,
  insertWorkItems,
  updateJobs,
} from "~/server/generic/jobs/jobs.fixtures";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { readDerivedBacklog } from "./backlog";

// Failure mode: a backlog that drained between 15 s reads showed "No values
// waiting to update" while values were updating, so Activity looked idle.
const KIND = "product";
const KEY = "synthetic";

describe("derived backlog", () => {
  const ctx = withTestDb();

  it("reports recent publications per minute and the oldest waiting value", async () => {
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic review progress" }),
      ctx.actor,
    );
    const assessment = await publishFieldAssessment(
      ctx.db,
      {
        entity: "product",
        recordId: source.entityId,
        field: "model",
        currentValue: null,
        suggestedValue: "Synthetic model",
        confidence: 0.9,
        model: "typesafe/jev",
        kind: "addition",
        status: "pending",
      },
      false,
    );
    await deleteWorkItems(ctx.db);
    const groupKey = `synthetic-progress-${assessment.id}`;
    await getDb(ctx.db).transaction((tx) =>
      writeAssessmentReadStage(
        tx,
        {
          stage: {
            id: crypto.randomUUID(),
            componentKey: groupKey,
            groups: [groupKey],
            assessmentIds: [assessment.id],
            revision: crypto.randomUUID(),
            nextIndex: 0,
            rulesVersion: ASSESSMENT_READ_RULES_VERSION,
            tickets: [],
          },
          previousStageIds: [],
          results: [
            {
              assessmentId: assessment.id,
              groupKey,
              facts: [],
              memberships: [],
              dependencies: [],
            },
          ],
        },
        { notify: () => {} },
      ),
    );
    const [active] = await getDb(ctx.db)
      .select()
      .from(assessmentReadPublication);
    if (!active) throw new Error("Synthetic publication missing");
    // A valid staged replacement is not committed publication progress.
    await getDb(ctx.db)
      .insert(assessmentReadPublication)
      .values({ ...active, active: false, revision: crypto.randomUUID() });
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
      { target: ASSESSMENT_READ_TARGET, ref: assessment.id },
      { target: `${ASSESSMENT_READ_TARGET}@0`, ref: crypto.randomUUID() },
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
    expect(backlog.recent.perMinute[14]).toBe(3);
    expect(backlog.recent.perMinute.reduce((sum, n) => sum + n, 0)).toBe(5);
    expect(
      backlog.recent.sources?.find(
        (entry) => entry.target === ASSESSMENT_READ_TARGET,
      )?.perMinute[14],
    ).toBe(1);
    expect(
      backlog.recent.sources?.find((entry) => entry.target === null)
        ?.perMinute[14],
    ).toBe(2);
    expect(
      backlog.internal?.find(
        (entry) => entry.target === ASSESSMENT_READ_TARGET,
      ),
    ).toMatchObject({
      count: 2,
      states: { queued: 2, running: 0, waiting: 0, failed: 0 },
    });
    expect(
      backlog.kinds.reduce((sum, kind) => sum + kind.count, 0) +
        (backlog.internal ?? []).reduce((sum, kind) => sum + kind.count, 0),
    ).toBe(backlog.total);
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

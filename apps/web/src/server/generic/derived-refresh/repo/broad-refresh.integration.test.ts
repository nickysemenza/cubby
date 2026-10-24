import { count, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityQuality,
  entityQualityCheck,
} from "~/server/db/entity-quality-schema";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  job,
  location,
  run,
  runStep,
  searchDocument,
} from "~/server/db/schema";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { qualityRefreshDriver } from "~/server/generic/data-quality/repo/refresh";
import {
  prepareQualityPublications,
  publishQualityRows,
} from "~/server/generic/data-quality/repo/stored";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import {
  createProductIdentityFixture,
  createImageFixture,
  insertEntityAttachments,
  insertEntityFixtures,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import {
  createProductionRefreshFamilyHandler,
  refreshFamilyHandler,
} from "~/server/workflows/background-tasks/refresh-families";

import { invalidateRefreshFamily, scheduleRefreshFamilies } from "./families";

// Broad pages must discover writes without endpoint capture, retain later
// invalidation during preparation, and never publish stale output after it.
// A rejected save must roll back all of its family intent. A pass records a
// `derived_refresh` Run only once a page has work; an idle pass leaves none
// but still ends the Run an abandoned generation opened. Pages scanned before
// the Run opened count as done, not as records that left the population.
describe("broad refresh jobs", () => {
  const ctx = withTestDb();
  it("returns authoritative publication changes for changed, unchanged and retired outcomes", async () => {
    const [saved] = await insertEntityFixtures(ctx.db, location, "location", [
      { shortcode: "LOC-2345", name: "Synthetic publication", type: "room" },
    ]);
    if (!saved) throw new Error("Expected location fixture");
    const ids = [saved.id];
    const rows = await prepareQualityPublications(ctx.db, "location", ids);
    const publish = async (next: typeof rows) =>
      withTransactionDatabase(ctx.db, (tx) =>
        publishQualityRows(tx, ids, next),
      );
    expect(await publish(rows)).toEqual(ids);
    expect(await publish(rows)).toEqual([]);
    const revised = rows.map((row) => ({
      ...row,
      rulesVersion: row.rulesVersion + 1,
    }));
    expect(await publish(revised)).toEqual(ids);
    expect(await publish(revised)).toEqual([]);
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, saved.id));
    const retired = await prepareQualityPublications(ctx.db, "location", ids);
    expect(retired).toEqual([]);
    expect(await publish(retired)).toEqual(ids);
    expect(await publish([])).toEqual([]);
    expect(await publishQualityRows(ctx.db, [], [])).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityQuality)
        .where(eq(entityQuality.entityId, saved.id)),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityQualityCheck)
        .where(eq(entityQualityCheck.entityId, saved.id)),
    ).toEqual([]);
  });

  it("publishes a source edit committed after preparation and keeps exact idle pending counts", async () => {
    const [saved] = await insertEntityFixtures(ctx.db, location, "location", [
      { shortcode: "LOC-2345", name: "Synthetic publication", type: "room" },
    ]);
    if (!saved) throw new Error("Expected location fixture");
    const image = await createImageFixture(
      ctx.db,
      "synthetic-concurrent-quality",
    );
    const boundary = new Date().toISOString();
    const before = await prepareQualityPublications(ctx.db, "location", [
      saved.id,
    ]);
    const page = await qualityRefreshDriver.page(ctx.db, null, boundary);
    expect(page.pending).toBeGreaterThan(0);
    await insertEntityAttachments(ctx.db, {
      entityId: saved.id,
      imageId: image.id,
      sortOrder: 0,
    });
    const current = await prepareQualityPublications(ctx.db, "location", [
      saved.id,
    ]);
    expect(before[0]?.checks.location_display_image).toBe("gap");
    expect(current[0]?.checks.location_display_image).toBe("pass");
    const result = await withTransactionDatabase(ctx.db, (tx) =>
      page.publish(tx),
    );
    expect(result.changed).toBeGreaterThan(0);
    const [published] = await getDb(ctx.db)
      .select()
      .from(entityQuality)
      .where(eq(entityQuality.entityId, saved.id));
    const checks = await getDb(ctx.db)
      .select()
      .from(entityQualityCheck)
      .where(eq(entityQualityCheck.entityId, saved.id));
    expect(published?.score).toBe(current[0]?.score);
    expect(
      Object.fromEntries(checks.map((check) => [check.checkKey, check.state])),
    ).toEqual(current[0]?.checks);
    const idle = await qualityRefreshDriver.page(ctx.db, null, boundary);
    expect(idle.pending).toBe(0);
    expect(
      await withTransactionDatabase(ctx.db, (tx) => idle.publish(tx)),
    ).toMatchObject({ changed: 0 });
  });

  it("rolls family intent back with a rejected save", async () => {
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await scheduleRefreshFamilies(tx, { invalidate: true });
        throw new Error("Synthetic rejected edit");
      }),
    ).rejects.toThrow("Synthetic rejected edit");
    expect(await getDb(ctx.db).select().from(job)).toEqual([]);
  });

  it("refreshes current source data without capture observations or dependency scheduling", async () => {
    const [saved] = await insertEntityFixtures(ctx.db, location, "location", [
      { shortcode: "LOC-2345", name: "Synthetic original", type: "room" },
    ]);
    if (!saved) throw new Error("Expected location fixture");
    await getDb(ctx.db)
      .update(location)
      .set({ name: "Synthetic latest" })
      .where(eq(location.id, saved.id));
    await scheduleRefreshFamilies(ctx.db, { invalidate: true });
    const [pending] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:search"));
    if (!pending) throw new Error("Expected search intent");
    await advanceJob(ctx.db, pending.id, {
      "refresh.family": refreshFamilyHandler,
    });
    const [document] = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, saved.id));
    expect(document?.title).toBe("Synthetic latest");
    const [pass] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "derived_refresh"));
    expect(pass).toMatchObject({
      status: "completed",
      input: { kind: "derived_refresh", family: "search" },
    });
    const steps = await getDb(ctx.db)
      .select()
      .from(runStep)
      .where(eq(runStep.runId, pass!.id));
    expect(steps).toMatchObject([
      {
        key: "search",
        state: "done",
        meta: {
          input: { mode: "count", boundary: expect.any(String) },
          tallies: { rebuilt: expect.any(Number) },
        },
      },
    ]);
    // The source COUNT is the population the pager walked.
    expect(steps[0]?.found).toBeGreaterThan(0);
    expect(steps[0]?.done).toBe(steps[0]?.found);
    expect(steps[0]?.meta?.tallies?.removed).toBeUndefined();
    const [advanced] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, pending.id));
    expect(advanced?.result).toMatchObject({ runId: pass!.id });
    // Recording the quality family's own Run must not restart its generation.
    const [qualityJob] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:quality"));
    if (!qualityJob) throw new Error("Expected quality intent");
    await advanceJob(ctx.db, qualityJob.id, {
      "refresh.family": refreshFamilyHandler,
    });
    const [qualityPass] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, qualityJob.id));
    expect(qualityPass?.state).toBe("completed");
  });

  it("finishes a quality pass that household writes keep invalidating", async () => {
    // Production writes arrive faster than a full pass; each one used to
    // restart the pass and supersede the page in flight.
    await insertEntityFixtures(
      ctx.db,
      location,
      "location",
      Array.from({ length: 201 }, (_, index) => ({
        shortcode: `LOC-${String(3000 + index)}`,
        name: `Synthetic room ${index}`,
        type: "room",
      })),
    );
    await invalidateRefreshFamily(ctx.db, "quality");
    const current = async () => {
      const [row] = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "refresh:quality"));
      if (!row) throw new Error("Expected quality intent");
      return row;
    };
    const first = await current();
    await advanceJob(ctx.db, first.id, {
      "refresh.family": refreshFamilyHandler,
    });
    const between = await current();
    expect(between.cursor).not.toBeNull();
    await invalidateRefreshFamily(ctx.db, "quality");
    expect(await current()).toMatchObject({
      generation: between.generation,
      cursor: between.cursor,
    });
    for (let page = 0; (await current()).state !== "completed"; page++) {
      if (page === 10) throw new Error("Quality pass did not finish");
      await advanceJob(ctx.db, first.id, {
        "refresh.family": refreshFamilyHandler,
      });
    }
    const [published] = await getDb(ctx.db)
      .select({ n: count() })
      .from(entityQuality)
      .where(eq(entityQuality.kind, "location"));
    const [locations] = await getDb(ctx.db)
      .select({ n: count() })
      .from(location);
    expect(published?.n).toBe(locations?.n);
  });

  it("leaves no Run for a pass with nothing to change", async () => {
    const abandoned = await ensureRun(ctx.db, systemActor(), {
      purpose: "derived_refresh",
      trigger: "scheduled",
      status: "running",
      execution: false,
      clientKey: "synthetic-abandoned-generation",
      input: { kind: "derived_refresh", family: "recipes" },
    });
    await scheduleRefreshFamilies(ctx.db, { invalidate: true });
    const [pending] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:recipes"));
    if (!pending) throw new Error("Expected recipes intent");
    await advanceJob(ctx.db, pending.id, {
      "refresh.family": refreshFamilyHandler,
    });
    const [finished] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, pending.id));
    expect(finished).toMatchObject({
      state: "completed",
      result: { outcome: "nothing" },
    });
    expect(
      await getDb(ctx.db)
        .select({ id: run.id, status: run.status, notes: run.notes })
        .from(run),
    ).toEqual([
      {
        id: abandoned,
        status: "completed",
        notes: "Superseded by a newer pass",
      },
    ]);
  });

  it("counts pages scanned before the Run opened as done", async () => {
    for (const name of ["first", "second", "third"])
      await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: `Synthetic ${name} product` }),
        ctx.actor,
      );
    // Two products are already current; the last page finds the change.
    const pages = [
      { nextCursor: "synthetic-cursor", scanned: 2, changed: 0 },
      { nextCursor: null, scanned: 1, changed: 1 },
    ];
    const handler = createProductionRefreshFamilyHandler({
      prepareConversions: async () => ({
        ...pages.shift()!,
        publish: async () => {},
      }),
    });
    await scheduleRefreshFamilies(ctx.db, { invalidate: true });
    const [pending] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:conversions"));
    if (!pending) throw new Error("Expected conversions intent");
    await advanceJob(ctx.db, pending.id, { "refresh.family": handler });
    await advanceJob(ctx.db, pending.id, { "refresh.family": handler });
    const [pass] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "derived_refresh"));
    const steps = await getDb(ctx.db)
      .select()
      .from(runStep)
      .where(eq(runStep.runId, pass!.id));
    expect(steps).toMatchObject([
      { key: "conversions", state: "done", found: 3, done: 3 },
    ]);
    expect(steps[0]?.meta?.tallies?.removed).toBeUndefined();
  });
});

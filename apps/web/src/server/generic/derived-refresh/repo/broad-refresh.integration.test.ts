import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  job,
  location,
  run,
  runStep,
  searchDocument,
} from "~/server/db/schema";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import {
  createProductIdentityFixture,
  insertEntityFixtures,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import {
  createProductionRefreshFamilyHandler,
  refreshFamilyHandler,
} from "~/server/workflows/background-tasks/refresh-families";

import { scheduleRefreshFamilies } from "./families";

// Broad pages must discover writes without endpoint capture, retain later
// invalidation during preparation, and never publish stale output after it.
// A rejected save must roll back all of its family intent. A pass records a
// `derived_refresh` Run only once a page has work; an idle pass leaves none
// but still ends the Run an abandoned generation opened. Pages scanned before
// the Run opened count as done, not as records that left the population.
describe("broad refresh jobs", () => {
  const ctx = withTestDb();
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

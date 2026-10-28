import { imageId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { aiAnalysis, location as locationTable } from "~/server/db/schema";
import { deleteImages } from "~/server/domains/image/repo/image";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { buildEntityReport } from "~/server/generic/entity-report/repo";
import { withJobExecution } from "~/server/generic/jobs/context";
import { claimExternal } from "~/server/generic/jobs/repo/external-claim";
import { cancelJob } from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { claimContext } from "~/server/generic/jobs/service/jobs";
import {
  createImageFixture,
  createLocationFixture,
  insertEntityAttachments,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

import { describeLocation, type LocationVisionAiPort } from "./location-vision";

/**
 * `describeLocation` writes the description before it returns, so a client cannot read "what it
 * was before" afterwards. The server says it, in the answer, so web and native both review the
 * same previous-versus-new pair without snapshotting a record that refetches underneath them.
 */
describe("describeLocation previous description", () => {
  const ctx = withTestDb();

  const portSaying = (description: string): LocationVisionAiPort => ({
    describeLocation: async () => ({ description, confidence: "high" }),
    detectInventoryItems: async () => {
      throw new Error("not used");
    },
  });

  // Paid results may be cached, but a cancelled Job or changed source cannot
  // make a new location analysis visible after the provider returns.
  it.each(["cancelled", "source_changed"])(
    "rejects a %s background description",
    async (change) => {
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Synthetic current shelf" }),
        ctx.actor,
      );
      const photo = await createImageFixture(
        ctx.db,
        "synthetic-stale-description",
      );
      await insertEntityAttachments(ctx.db, {
        entityId: location.entityId,
        imageId: photo.id,
        sortOrder: 0,
      });
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "background",
        trigger: "manual",
      });
      const saved = await enqueueJob(ctx.db, {
        key: `synthetic-location:${location.entityId}`,
        kind: "location-ai.description.refresh",
        input: {},
      });
      const claim = await claimExternal(ctx.db, saved.id);
      if (!claim) throw new Error("Expected location Job");
      const ai: LocationVisionAiPort = {
        ...portSaying("Synthetic stale answer"),
        describeLocation: async () => {
          if (change === "cancelled") await cancelJob(ctx.db, saved.id);
          else
            await getDb(ctx.db)
              .update(locationTable)
              .set({ name: "Synthetic changed shelf" })
              .where(eq(locationTable.id, location.entityId));
          return { description: "Synthetic stale answer", confidence: "high" };
        },
      };
      await expect(
        withJobExecution(ctx.db, claim, () =>
          describeLocation(
            ctx.db,
            location.entityId,
            runId,
            ai,
            claimContext(ctx.db, claim).fenced,
          ),
        ),
      ).rejects.toThrow(
        change === "cancelled"
          ? "Job generation or lease is obsolete"
          : "Location inputs changed",
      );
      expect(
        await getDb(ctx.db)
          .select()
          .from(aiAnalysis)
          .where(eq(aiAnalysis.entityId, location.entityId)),
      ).toEqual([]);
    },
  );

  // An uncommitted image deletion is invisible to ordinary fingerprint reads.
  // Publication must wait for that writer and reject its removed-photo result.
  it("rejects a description overlapping an uncommitted analyzed image deletion", async () => {
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic disappearing photo" }),
      ctx.actor,
    );
    const photo = await createImageFixture(
      ctx.db,
      "synthetic-overlapping-location-photo",
    );
    await insertEntityAttachments(ctx.db, {
      entityId: location.entityId,
      imageId: photo.id,
      sortOrder: 0,
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "manual",
    });
    const saved = await enqueueJob(ctx.db, {
      key: `synthetic-location-overlap:${location.entityId}`,
      kind: "location-ai.description.refresh",
      input: {},
    });
    const claim = await claimExternal(ctx.db, saved.id);
    if (!claim) throw new Error("Expected location Job");
    const deleted = Promise.withResolvers<void>();
    const allowCommit = Promise.withResolvers<void>();
    const deletion = withTransactionDatabase(ctx.db, async (tx) => {
      await deleteImages(tx, [imageId.parse(photo.id)]);
      deleted.resolve();
      await allowCommit.promise;
    });
    await deleted.promise;
    let settled = false;
    const analysis = withJobExecution(ctx.db, claim, () =>
      describeLocation(
        ctx.db,
        location.entityId,
        runId,
        portSaying("Synthetic removed-photo answer"),
        claimContext(ctx.db, claim).fenced,
      ),
    ).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await expect
        .poll(async () => {
          if (settled) return "published";
          const waiting = await getDb(ctx.db).execute(
            sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query ILIKE '%Image%' AND wait_event_type='Lock'`,
          );
          return waiting.rows.length ? "blocked" : "starting";
        })
        .toBe("blocked");
    } finally {
      allowCommit.resolve();
      await deletion;
    }
    expect(await analysis).toBeInstanceOf(Error);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, location.entityId)),
    ).toEqual([]);
  });

  it("returns the description that stood before this run, and null for the first", async () => {
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic shelf" }),
      ctx.actor,
    );
    const photo = await createImageFixture(ctx.db, "describe-previous");
    await insertEntityAttachments(ctx.db, {
      entityId: location.entityId,
      imageId: photo.id,
      sortOrder: 0,
    });
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      {
        purpose: "background",
        trigger: "manual",
        notes: "Synthetic location analysis",
      },
    );

    const first = await describeLocation(
      ctx.db,
      location.entityId,
      runId,
      portSaying("Two paint cans"),
    );
    expect(first.previousDescription).toBeNull();
    expect(first.description).toBe("Two paint cans");

    // A second photo changes the analysis fingerprint, so the next run reads again.
    const another = await createImageFixture(ctx.db, "describe-previous-two");
    await insertEntityAttachments(ctx.db, {
      entityId: location.entityId,
      imageId: another.id,
      sortOrder: 1,
    });
    const second = await describeLocation(
      ctx.db,
      location.entityId,
      runId,
      portSaying("Paint cans and a tarp"),
    );
    expect(second.previousDescription).toBe("Two paint cans");
    expect(second.description).toBe("Paint cans and a tarp");

    // The section's report shows the same, current description (a correlated lookup that read
    // the analysis row's own id once returned nothing here).
    const report = await buildEntityReport(
      ctx.db,
      {
        slot: "location.ai-description",
        scope: { kind: "record", id: location.id },
      },
      async () => null,
      ctx.actor,
    );
    expect(report.blocks[0]).toMatchObject({
      kind: "records",
      rows: [{ title: "Paint cans and a tarp" }],
    });
  });
});

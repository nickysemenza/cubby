import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { buildEntityReport } from "~/server/repo/entity-report";
import {
  createImageFixture,
  createLocationFixture,
  insertEntityAttachments,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { ensureRun } from "~/server/runs/ensure-run";

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
      { slot: "location.ai-description", id: location.id },
      async () => null,
      ctx.actor,
    );
    expect(report.blocks[0]).toMatchObject({
      kind: "records",
      rows: [{ title: "Paint cans and a tarp" }],
    });
  });
});

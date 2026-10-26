import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import {
  ledgerParty,
  photoRunImage,
  run as runTable,
} from "~/server/db/schema";
import { loadRunDetail } from "~/server/domains/purchase-import/repo/run-service";
import { writeOutcomeReceipts } from "~/server/domains/purchase-import/service/run-outcome.fixtures";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { listRunsRead } from "~/server/domains/run/repo/run";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";
import { createImageFixture } from "~/server/testing/repo.fixtures";

import { loadDataQualities } from "./hydrate";
import { scoreSql, statusCondition } from "./sql";

// A complete outcome must not hide unfinished targets, missing skip reasons,
// or an impossible timeline. Active work and non-browser work remain valid.
describe("Run data quality", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic Run member",
      kind: "member",
    });
    await unwrapDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, member.entityId));
  });
  const start = new Date("2026-09-01T10:00:00Z");
  const end = new Date("2026-09-01T10:01:00Z");

  const makeRun = async (
    status: "running" | "completed",
    endedAt: Date | null = end,
    purpose: "product_enrichment" | "photo_inventory" = "product_enrichment",
  ) => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose,
      trigger: "manual",
      execution: false,
      status,
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Run" SET "startedAt" = ${start}, "endedAt" = ${endedAt} WHERE id = ${id}`,
    );
    const [row] = await unwrapDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, id));
    return row!;
  };

  it("scores complete and honestly skipped targets without requiring a browser capture", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture packet",
      brandId: await findOrCreateVendor(ctx.db, "Fixture Seeds"),
    });
    const completed = await makeRun("completed");
    const skipped = await makeRun("completed");
    const active = await makeRun("running", null);
    await writeOutcomeReceipts(ctx.db, [
      {
        runId: completed.id,
        entityKind: "product",
        entityId: product.id,
        state: "completed",
        outcome: "enriched",
        completedAt: end,
        targetFingerprint: "a".repeat(64),
      },
      {
        runId: skipped.id,
        entityKind: "product",
        entityId: product.id,
        state: "skipped",
        outcome: "skipped",
        warning: "The source cannot distinguish this variant",
        completedAt: end,
        targetFingerprint: "b".repeat(64),
      },
      {
        runId: active.id,
        entityKind: "product",
        entityId: product.id,
        state: "pending",
        targetFingerprint: "c".repeat(64),
      },
    ]);
    const qualities = await loadDataQualities(ctx.db, "run", [
      completed.id,
      skipped.id,
      active.id,
    ]);
    for (const run of [completed, skipped, active])
      expect(qualities.get(run.id)).toMatchObject({
        score: 99,
        status: "needs_data",
        gaps: [{ check: "run_display_image" }],
      });
  });

  it("exposes invalid completion records through live hydration and published filters", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture packet",
      brandId: await findOrCreateVendor(ctx.db, "Fixture Seeds"),
    });
    const unfinished = await makeRun("completed");
    const unexplained = await makeRun("completed");
    const empty = await makeRun("completed");
    const badClock = await makeRun("running", new Date("2026-09-01T09:59:00Z"));
    await writeOutcomeReceipts(ctx.db, [
      {
        runId: unfinished.id,
        entityKind: "product",
        entityId: product.id,
        state: "pending",
        targetFingerprint: "d".repeat(64),
      },
      {
        runId: unexplained.id,
        entityKind: "product",
        entityId: product.id,
        state: "skipped",
        outcome: "skipped",
        completedAt: end,
        targetFingerprint: "e".repeat(64),
      },
    ]);
    const qualities = await loadDataQualities(ctx.db, "run", [
      unfinished.id,
      unexplained.id,
      empty.id,
      badClock.id,
    ]);
    for (const run of [unfinished, unexplained, empty]) {
      expect(qualities.get(run.id)?.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check: "run_target_outcomes" }),
        ]),
      );
      expect(qualities.get(run.id)?.score).toBeLessThan(100);
    }
    expect(qualities.get(badClock.id)?.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "run_timeline" }),
      ]),
    );
    expect(qualities.get(badClock.id)?.status).toBe("defect");
    await publishQualityFixtures(ctx.db, "run");
    const filtered = await unwrapDb(ctx.db)
      .select({ id: runTable.id, score: scoreSql("run", runTable) })
      .from(runTable)
      .where(statusCondition("run", "defect", runTable));
    expect(filtered.map((row) => row.id)).toEqual(
      expect.arrayContaining([unfinished.id, badClock.id]),
    );
    expect(
      Number(filtered.find((row) => row.id === unfinished.id)?.score),
    ).toBe(qualities.get(unfinished.id)?.score);
  });
  it("checks the live photo roster and requires an explanation for skipped images", async () => {
    const run = await makeRun("completed", end, "photo_inventory");
    const image = await createImageFixture(ctx.db, "synthetic-quality-photo");
    await unwrapDb(ctx.db)
      .insert(photoRunImage)
      .values({
        runId: run.id,
        imageId: parseEntityId("image", image.id),
        position: 0,
        targetFingerprint: "a".repeat(64),
        state: "skipped",
        outcome: "skipped",
        completedAt: end,
      });
    const before = (await loadDataQualities(ctx.db, "run", [run.id])).get(
      run.id,
    );
    expect(before?.gaps.map((gap) => gap.check)).toContain(
      "run_target_outcomes",
    );
    await unwrapDb(ctx.db)
      .update(photoRunImage)
      .set({ skipReason: "Synthetic duplicate photo" })
      .where(eq(photoRunImage.runId, run.id));
    await publishQualityFixtures(ctx.db, "run");
    const after = (
      await loadDataQualities(ctx.db, "run", [run.id], "stored")
    ).get(run.id);
    expect(after?.gaps.map((gap) => gap.check)).not.toContain(
      "run_target_outcomes",
    );
  });
  it("projects the target account's human label rather than its identifier", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture packet",
      brandId: await findOrCreateVendor(ctx.db, "Fixture Seeds"),
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture vendor",
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Fixture owner",
      kind: "guest",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await makeRun("completed");
    await writeOutcomeReceipts(ctx.db, [
      {
        runId: run.id,
        vendorAccountId: account.id,
        entityKind: "product",
        entityId: product.id,
        state: "completed",
        outcome: "enriched",
        completedAt: end,
        targetFingerprint: "f".repeat(64),
      },
    ]);
    expect(
      (await loadRunDetail(ctx.db, run.shortcode)).targets[0]
        ?.vendorAccountLabel,
    ).toBe("Fixture vendor · Fixture owner");
  });
  it("delivers quality through the progressive enrichment projection", async () => {
    const run = await makeRun("running", null);
    await publishQualityFixtures(ctx.db, "run");
    const args = [{}, [], { pageIndex: 0, pageSize: 50 }] as const;
    const base = await listRunsRead(ctx.db, args[0], [...args[1]], args[2], {
      kind: "base",
    });
    const enriched = await listRunsRead(
      ctx.db,
      args[0],
      [...args[1]],
      args[2],
      { kind: "selected", fields: ["dataQuality"] },
    );
    expect(
      base.data.find((row) => row.id === run.shortcode)?.dataQuality,
    ).toBeUndefined();
    expect(
      enriched.data.find((row) => row.id === run.shortcode)?.dataQuality,
    ).toMatchObject({ score: 99, status: "needs_data" });
  });
});

import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import { photoRunImage } from "~/server/db/schema";
import { startPhotoInventoryRun } from "~/server/domains/purchase-import/repo/run-service";
import { mergePhotoRunImages } from "~/server/domains/run/repo/run-target-merge";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createImageFixture } from "~/server/testing/repo.fixtures";

// Colliding membership must carry terminal replay data onto the surviving
// image rather than drop its receipt or leave a reference to the loser.
describe("photo membership merge replay", () => {
  const ctx = withTestDb();
  it("keeps a completed loser receipt when the surviving image membership is pending", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic merge member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const keeper = await createImageFixture(ctx.db, "synthetic-merge-keeper");
    const loser = await createImageFixture(ctx.db, "synthetic-merge-loser");
    const receipt = { groupKey: "synthetic-settled-group" };
    await getDb(ctx.db)
      .insert(photoRunImage)
      .values([
        {
          runId: run.id,
          imageId: parseEntityId("image", keeper.id),
          targetFingerprint: "keeper",
          state: "pending",
        },
        {
          runId: run.id,
          imageId: parseEntityId("image", loser.id),
          targetFingerprint: "loser",
          state: "skipped",
          outcome: "skipped",
          skipReason: "Synthetic duplicate",
          commitReceipt: receipt,
          completedAt: new Date(),
        },
      ]);
    await withTransaction(ctx.db, (tx) =>
      mergePhotoRunImages(tx, parseEntityId("image", keeper.id), [
        parseEntityId("image", loser.id),
      ]),
    );
    const memberships = await getDb(ctx.db)
      .select()
      .from(photoRunImage)
      .where(eq(photoRunImage.runId, run.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      imageId: keeper.id,
      state: "skipped",
      outcome: "skipped",
      commitReceipt: receipt,
      skipReason: "Synthetic duplicate",
    });
  });
  it("refuses to discard conflicting settled receipts", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic conflict member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const keeper = await createImageFixture(
      ctx.db,
      "synthetic-conflict-keeper",
    );
    const loser = await createImageFixture(ctx.db, "synthetic-conflict-loser");
    await getDb(ctx.db)
      .insert(photoRunImage)
      .values([
        {
          runId: run.id,
          imageId: parseEntityId("image", keeper.id),
          targetFingerprint: "keeper",
          state: "skipped",
          outcome: "skipped",
          commitReceipt: { groupKey: "synthetic-first" },
        },
        {
          runId: run.id,
          imageId: parseEntityId("image", loser.id),
          targetFingerprint: "loser",
          state: "skipped",
          outcome: "skipped",
          commitReceipt: { groupKey: "synthetic-second" },
        },
      ]);
    await expect(
      withTransaction(ctx.db, (tx) =>
        mergePhotoRunImages(tx, parseEntityId("image", keeper.id), [
          parseEntityId("image", loser.id),
        ]),
      ),
    ).rejects.toThrow(/conflicting settled photo receipts/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(photoRunImage)
        .where(eq(photoRunImage.runId, run.id)),
    ).toHaveLength(2);
  });
});

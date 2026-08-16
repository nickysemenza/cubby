import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { listBackgroundBatches } from "~/server/repo/background-jobs";
import { createUploadedImageRecord } from "~/server/repo/image";
import { makeLocationInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestCaller } from "../trpc";
import { locationRouter } from "./location";

// Kinds enqueued for a given location id (metadata.entity.entityId), across all batches.
const kindsForLocation = async (
  db: Parameters<typeof listBackgroundBatches>[0],
  locationId: string,
) =>
  (await listBackgroundBatches(db, 50))
    .filter(
      (b) =>
        (b.metadata as { entity?: { entityId?: string } } | null)?.entity
          ?.entityId === locationId,
    )
    .map((b) => b.kind);

describe("location.create AI-description side-effect", () => {
  const ctx = withTestDb();

  // Regression: creating a location WITH photos used to skip the vision job
  // (only location.update set locationImagesChanged), so it was born with a
  // NULL aiDescription — a permanent "missing AI description" the Problems page
  // flagged. The create handler now passes the flag when photos are attached.
  it("enqueues a description refresh when created with photos", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const image = await createUploadedImageRecord(ctx.db, {
      key: "loc-create-ai.jpg",
      url: "https://example.com/loc-create-ai.jpg",
      filename: "loc-create-ai.jpg",
      contentType: "image/jpeg",
      size: 123,
    });

    const created = await caller.create(
      makeLocationInput({
        name: "Created with photo",
        pendingImageIds: [image.id],
      }),
    );
    const entityId = await resolveLiveShortcode(ctx.db, created.id, "location");

    const kinds = await kindsForLocation(ctx.db, entityId!);
    expect(kinds).toContain("location-ai.description.refresh");
    expect(kinds).toContain("location-ai.inventory.refresh");
  });

  it("does NOT enqueue a description refresh when created without photos", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const created = await caller.create(
      makeLocationInput({ name: "Created no photo", pendingImageIds: [] }),
    );
    const entityId = await resolveLiveShortcode(ctx.db, created.id, "location");

    const kinds = await kindsForLocation(ctx.db, entityId!);
    expect(kinds).not.toContain("location-ai.description.refresh");
    expect(kinds).not.toContain("location-ai.inventory.refresh");
  });

  /**
   * The photo-capture path attaches, then sends a SECOND order-only update to
   * make the new photo the cover (see `useLocationPhotoCapture`). That second
   * call must not re-enqueue vision analysis, or every retake bills twice.
   * `locationImagesChanged` is computed from `pendingImageIds`/`removeImageIds`
   * and deliberately excludes `imageOrder` — this is what pins that.
   */
  it("does NOT re-enqueue analysis for an imageOrder-only update", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const first = await createUploadedImageRecord(ctx.db, {
      key: "loc-order-a.jpg",
      url: "https://example.com/loc-order-a.jpg",
      filename: "loc-order-a.jpg",
      contentType: "image/jpeg",
      size: 123,
    });
    const second = await createUploadedImageRecord(ctx.db, {
      key: "loc-order-b.jpg",
      url: "https://example.com/loc-order-b.jpg",
      filename: "loc-order-b.jpg",
      contentType: "image/jpeg",
      size: 123,
    });
    const created = await caller.create(
      makeLocationInput({
        name: "Reordered only",
        pendingImageIds: [first.id, second.id],
      }),
    );
    const entityId = await resolveLiveShortcode(ctx.db, created.id, "location");
    const visionKinds = async () =>
      (await kindsForLocation(ctx.db, entityId!)).filter((kind) =>
        kind.startsWith("location-ai."),
      );
    // The create attached photos, so it legitimately enqueued one round.
    const before = await visionKinds();
    expect(before.length).toBeGreaterThan(0);

    await caller.update({
      id: created.id,
      data: { imageOrder: [second.id, first.id] },
    });

    // Counting only `location-ai.*`: a reorder still refreshes the location's
    // own embedding, which is free — it is the paid vision pass that must not
    // repeat.
    expect(await visionKinds()).toHaveLength(before.length);
  });
});

describe("location.bulkUpdateParent", () => {
  const ctx = withTestDb();

  it("rejects moving a location under its own descendant", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const root = await caller.create(makeLocationInput({ name: "Cycle root" }));
    const child = await caller.create(
      makeLocationInput({ name: "Cycle child", parentId: root.id }),
    );
    const grandchild = await caller.create(
      makeLocationInput({ name: "Cycle grandchild", parentId: child.id }),
    );

    await expect(
      caller.bulkUpdateParent({ ids: [root.id], parentId: grandchild.id }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Cannot set parent: would create a circular reference",
    });
  });
});

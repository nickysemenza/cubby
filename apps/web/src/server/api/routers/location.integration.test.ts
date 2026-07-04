import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { listBackgroundBatches } from "~/server/repo/background-jobs";
import { createUploadedImageRecord } from "~/server/repo/image";
import { makeLocationInput } from "~/server/repo/repo.fixtures";
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

    const kinds = await kindsForLocation(ctx.db, created.id);
    expect(kinds).toContain("location-ai.description.refresh");
    expect(kinds).toContain("location-ai.inventory.refresh");
  });

  it("does NOT enqueue a description refresh when created without photos", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const created = await caller.create(
      makeLocationInput({ name: "Created no photo", pendingImageIds: [] }),
    );

    const kinds = await kindsForLocation(ctx.db, created.id);
    expect(kinds).not.toContain("location-ai.description.refresh");
    expect(kinds).not.toContain("location-ai.inventory.refresh");
  });
});

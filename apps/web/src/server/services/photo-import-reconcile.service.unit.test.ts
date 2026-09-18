import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImageWithEntity } from "@cubby/schemas/image";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import { reconcilePhotoImport } from "~/server/services/photo-import-reconcile.service";

// SAFETY: every test replaces all database-touching ports; this value is only
// an opaque identity token passed between the injected transaction callbacks.
const database = {} as Database;
const imageA = parseShortcodeFor("image", "IMG-AAAA");
const imageB = parseShortcodeFor("image", "IMG-BBBB");
const productA = parseShortcodeFor("product", "PRD-AAAA");
const uploadedImage: ImageWithEntity = {
  id: imageA,
  url: "https://example.test/image.jpg",
  key: "image.jpg",
  filename: "image.jpg",
  size: 1,
  contentType: "image/jpeg",
  status: "UPLOADED",
  createdAt: new Date("2026-09-17T00:00:00Z"),
  updatedAt: new Date("2026-09-17T00:00:00Z"),
  entityType: "PRODUCT",
  entityId: productA,
  entityName: "Example",
  associations: [
    {
      entityType: "product",
      entityId: productA,
      entityName: "Example",
      role: "attachment",
    },
  ],
  sha256: null,
  width: null,
  height: null,
  detectedContentType: null,
  renderStatus: null,
  storageStatus: null,
  verifiedAt: null,
};

describe("reconcilePhotoImport", () => {
  it("locks the complete batch before reading one association snapshot", async () => {
    const events: string[] = [];
    const result = await reconcilePhotoImport(
      database,
      { imageIds: [imageA, imageB, imageA] },
      {
        withTransaction: vi.fn(async (_db, operation) => {
          events.push("transaction");
          return operation(database);
        }),
        lockImages: vi.fn(async (_db, imageIds) => {
          events.push(`lock:${imageIds.join(",")}`);
          return [];
        }),
        getImages: vi.fn(async (_db, imageIds) => {
          events.push(`read:${imageIds.join(",")}`);
          return [uploadedImage];
        }),
      },
    );

    expect(events).toEqual([
      "transaction",
      "lock:IMG-AAAA,IMG-BBBB",
      "read:IMG-AAAA,IMG-BBBB",
    ]);
    expect(result.items).toEqual([
      expect.objectContaining({ imageId: "IMG-AAAA", status: "UPLOADED" }),
    ]);
    expect(result.missing).toEqual(["IMG-BBBB"]);
  });
});

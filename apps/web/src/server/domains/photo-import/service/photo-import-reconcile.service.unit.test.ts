import { shortcode } from "@cubby/schemas/identifiers";
import type { ImageWithEntity } from "@cubby/schemas/image";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import { reconcilePhotoImport } from "~/server/domains/photo-import/service/photo-import-reconcile.service";

const database = {} as Database;
const imageA = shortcode("IMG-AAAA");
const imageB = shortcode("IMG-BBBB");
const productA = shortcode("PRD-AAAA");
const uploadedImage: ImageWithEntity = {
  id: imageA,
  url: "https://example.test/image.jpg",
  key: "image.jpg",
  filename: "image.jpg",
  size: 1,
  contentType: "image/jpeg",
  status: "UPLOADED",
  useOriginal: false,
  createdAt: new Date("2026-09-17T00:00:00Z"),
  updatedAt: new Date("2026-09-17T00:00:00Z"),
  associations: [
    {
      entityKind: "product",
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
  source: "unknown",
  sourcePageUrl: null,
  sourceAssetUrl: null,
  sourceName: null,
  capturedAt: null,
  capturedAtOffsetMinutes: null,
  captureLocation: null,
  capturePlaceName: null,
  captureDeviceLabel: null,
  capturedByPartyId: null,
  capturedByName: null,
  captureAttribution: "none",
  provenanceEvidence: null,
  sourceEvidence: null,
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

import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getImagesAttachedToEntity: vi.fn(),
  updateImageIntegrity: vi.fn(),
  getS3Object: vi.fn(),
  inspectImageFile: vi.fn(),
}));

vi.mock("~/server/repo/image", () => ({
  getImagesAttachedToEntity: mocks.getImagesAttachedToEntity,
  updateImageIntegrity: mocks.updateImageIntegrity,
}));

vi.mock("~/server/utils/s3", () => ({
  getS3Object: mocks.getS3Object,
}));

vi.mock("~/server/services/image-integrity", () => ({
  inspectImageFile: mocks.inspectImageFile,
}));

import { verifyProductImages } from "./image-verification.service";

const stored = {
  id: "11111111-1111-1111-1111-111111111111",
  key: "products/photo.png",
  contentType: "image/png",
  size: 3,
  width: null,
  height: null,
  detectedContentType: null,
  sha256: null,
};

const inspected = {
  contentType: "image/png",
  width: 1,
  height: 1,
  detectedContentType: "image/png",
  sha256: "abc123",
  renderStatus: "verified" as const,
  storageStatus: "available" as const,
  verifiedAt: new Date("2026-08-01T00:00:00Z"),
};

describe("verifyProductImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getImagesAttachedToEntity.mockResolvedValue([stored]);
    mocks.inspectImageFile.mockResolvedValue(inspected);
  });

  it("records a missing R2 object", async () => {
    const productId = testEntityId("product", "missing");
    mocks.getS3Object.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(verifyProductImages({} as never, productId)).resolves.toEqual([
      { imageId: stored.id, storageStatus: "missing" },
    ]);
    expect(mocks.getImagesAttachedToEntity).toHaveBeenCalledWith(
      {},
      {
        entity: "product",
        id: productId,
      },
    );
    expect(mocks.updateImageIntegrity).toHaveBeenCalledWith(
      {},
      stored.id,
      expect.objectContaining({
        renderStatus: "failed",
        storageStatus: "missing",
      }),
    );
  });

  it("backfills integrity metadata for a legacy row", async () => {
    mocks.getS3Object.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await expect(
      verifyProductImages({} as never, testEntityId("product", "backfill")),
    ).resolves.toEqual([{ imageId: stored.id, storageStatus: "available" }]);
    expect(mocks.updateImageIntegrity).toHaveBeenCalledWith(
      {},
      stored.id,
      inspected,
    );
  });

  it("retains recorded metadata and marks changed bytes as a mismatch", async () => {
    mocks.getImagesAttachedToEntity.mockResolvedValue([
      { ...stored, sha256: "original-hash" },
    ]);
    mocks.getS3Object.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await expect(
      verifyProductImages({} as never, testEntityId("product", "mismatch")),
    ).resolves.toEqual([
      { imageId: stored.id, storageStatus: "metadata_mismatch" },
    ]);
    expect(mocks.updateImageIntegrity).toHaveBeenCalledWith(
      {},
      stored.id,
      expect.objectContaining({
        renderStatus: "failed",
        storageStatus: "metadata_mismatch",
      }),
    );
  });
});

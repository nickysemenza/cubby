import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createUploadedImageRecord: vi.fn(),
  deleteS3Object: vi.fn(),
  fetchAndStoreImage: vi.fn(),
}));

vi.mock("~/server/repo/image", () => ({
  createPendingImageRecord: vi.fn(),
  createUploadedImageRecord: mocks.createUploadedImageRecord,
  cullPendingImages: vi.fn(),
  getImageByKey: vi.fn(),
}));

vi.mock("~/server/utils/s3", () => ({
  contentTypeToExtension: () => "jpg",
  deleteS3Object: mocks.deleteS3Object,
  extractKeyFromUrl: vi.fn(),
  fetchAndStoreImage: mocks.fetchAndStoreImage,
  generateImageKey: vi.fn(),
  generatePresignedUploadUrl: vi.fn(),
  getS3ObjectUrl: vi.fn(),
  isOurBucketUrl: () => false,
}));

import { importImageFromUrl } from "./image-storage.service";

describe("importImageFromUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteS3Object.mockResolvedValue(undefined);
    mocks.fetchAndStoreImage.mockResolvedValue({
      key: "imports/recipe.jpg",
      url: "https://images.example/imports/recipe.jpg",
      size: 123,
      contentType: "image/jpeg",
    });
  });

  it("deletes the uploaded object when record creation fails", async () => {
    const databaseError = new Error("database unavailable");
    mocks.createUploadedImageRecord.mockRejectedValue(databaseError);

    await expect(
      importImageFromUrl({} as never, {
        sourceUrl: "https://recipes.example/photo.jpg?token=secret",
        filenamePrefix: "recipe",
      }),
    ).rejects.toBe(databaseError);
    expect(mocks.deleteS3Object).toHaveBeenCalledWith("imports/recipe.jpg");
  });
});

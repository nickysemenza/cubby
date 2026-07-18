import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPendingImageRecord: vi.fn(),
  createUploadedImageRecord: vi.fn(),
  deleteS3Object: vi.fn(),
  fetchAndStoreImage: vi.fn(),
  getImageByKey: vi.fn(),
  generatePresignedUploadUrl: vi.fn(),
}));

vi.mock("~/server/repo/image", () => ({
  createPendingImageRecord: mocks.createPendingImageRecord,
  createUploadedImageRecord: mocks.createUploadedImageRecord,
  cullPendingImages: vi.fn(),
  getImageByKey: mocks.getImageByKey,
}));

vi.mock("~/server/utils/s3", () => ({
  contentTypeToExtension: () => "jpg",
  deleteS3Object: mocks.deleteS3Object,
  extractKeyFromUrl: vi.fn(),
  fetchAndStoreImage: mocks.fetchAndStoreImage,
  generateImageKey: vi.fn(),
  generateDocumentKey: (filename: string, folder?: string) =>
    `cubby/documents/${folder ? `${folder}/` : ""}${filename}`,
  generatePresignedUploadUrl: mocks.generatePresignedUploadUrl,
  getS3ObjectUrl: (key: string) => `https://images.example/${key}`,
  isOurBucketUrl: () => false,
}));

import {
  importImageFromUrl,
  initiateDocumentUpload,
} from "./image-storage.service";

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

describe("initiateDocumentUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPendingImageRecord.mockResolvedValue({ id: "img-1" });
    mocks.generatePresignedUploadUrl.mockResolvedValue(
      "https://r2.example/put",
    );
    mocks.getImageByKey.mockResolvedValue(null);
  });

  it("preserves the original filename under the folder", async () => {
    const result = await initiateDocumentUpload({} as never, {
      filename: "blender-manual.pdf",
      contentType: "application/pdf",
      size: 1024,
      entityType: "PRODUCT",
      folder: "P-0123",
    });

    expect(result.key).toBe("cubby/documents/P-0123/blender-manual.pdf");
    expect(result.imageId).toBe("img-1");
    expect(mocks.createPendingImageRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        filename: "blender-manual.pdf",
        contentType: "application/pdf",
        key: "cubby/documents/P-0123/blender-manual.pdf",
      }),
    );
  });

  it("falls back to a timestamped key when the filename collides", async () => {
    mocks.getImageByKey.mockResolvedValueOnce({
      id: "existing",
      url: "https://images.example/x",
      key: "cubby/documents/P-0123/blender-manual.pdf",
    });

    const result = await initiateDocumentUpload({} as never, {
      filename: "blender-manual.pdf",
      contentType: "application/pdf",
      size: 1024,
      entityType: "PRODUCT",
      folder: "P-0123",
    });

    expect(result.key).toMatch(
      /^cubby\/documents\/P-0123\/blender-manual-\d+\.pdf$/,
    );
  });
});

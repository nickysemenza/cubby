import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPendingImageRecord: vi.fn(),
  createUploadedImageRecord: vi.fn(),
  deleteS3Object: vi.fn(),
  fetchAndStoreImage: vi.fn(),
  getImageByKey: vi.fn(),
  generatePresignedUploadUrl: vi.fn(),
  uploadToS3: vi.fn(),
  assertAttachableEntityExists: vi.fn(),
  createAndAssociateUploadedImage: vi.fn(),
  fetchExternalResponse: vi.fn(),
  resolveLiveShortcode: vi.fn(),
}));

vi.mock("~/server/repo/image", () => ({
  createPendingImageRecord: mocks.createPendingImageRecord,
  createUploadedImageRecord: mocks.createUploadedImageRecord,
  cullPendingImages: vi.fn(),
  getImageByKey: mocks.getImageByKey,
  assertAttachableEntityExists: mocks.assertAttachableEntityExists,
  createAndAssociateUploadedImage: mocks.createAndAssociateUploadedImage,
}));

vi.mock("~/server/repo/shortcode-resolver", () => ({
  resolveLiveShortcode: mocks.resolveLiveShortcode,
}));

vi.mock("~/server/utils/s3", () => ({
  contentTypeToExtension: (ct: string) => (ct === "image/png" ? "png" : "jpg"),
  deleteS3Object: mocks.deleteS3Object,
  extractKeyFromUrl: vi.fn(),
  fetchAndStoreImage: mocks.fetchAndStoreImage,
  generateImageKey: (filename: string) => `cubby/images/${filename}`,
  generateDocumentKey: (filename: string, folder?: string) =>
    `cubby/documents/${folder ? `${folder}/` : ""}${filename}`,
  generatePresignedUploadUrl: mocks.generatePresignedUploadUrl,
  getS3ObjectUrl: (key: string) => `https://images.example/${key}`,
  isOurBucketUrl: () => false,
  uploadToS3: mocks.uploadToS3,
}));

vi.mock("@cubby/shared/external-fetch", async (importActual) => ({
  ...(await importActual<typeof import("@cubby/shared/external-fetch")>()),
  fetchExternalResponse: mocks.fetchExternalResponse,
}));

import type { McpAttachFileInput } from "@cubby/schemas/image";
import { ExternalFetchError } from "@cubby/shared/external-fetch";
import {
  attachFileToEntity,
  importImageFromUrl,
  initiateDocumentUpload,
} from "./image-storage.service";

// 1×1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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

describe("attachFileToEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAttachableEntityExists.mockResolvedValue(undefined);
    mocks.uploadToS3.mockResolvedValue(undefined);
    mocks.deleteS3Object.mockResolvedValue(undefined);
    mocks.createAndAssociateUploadedImage.mockResolvedValue({ id: "img-99" });
    mocks.resolveLiveShortcode.mockResolvedValue("prod-1");
  });

  const base = {
    entityType: "product",
    entityId: "PRD-TEST",
  } satisfies Partial<McpAttachFileInput>;

  it("stores a base64 image, associates it, and reports kind=image", async () => {
    const result = await attachFileToEntity({} as never, {
      ...base,
      data: PNG_BASE64,
      contentType: "image/png",
    });

    expect(result.kind).toBe("image");
    expect(result.imageId).toBe("img-99");
    expect(result.entityId).toBe("PRD-TEST");
    expect(mocks.uploadToS3).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringContaining("cubby/images/"),
        contentType: "image/png",
      }),
    );
    expect(mocks.createAndAssociateUploadedImage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ contentType: "image/png", size: 70 }),
      "product",
      "prod-1",
    );
  });

  it("parses a data: URI and infers the content type", async () => {
    const result = await attachFileToEntity({} as never, {
      ...base,
      data: `data:image/png;base64,${PNG_BASE64}`,
    });

    expect(result.contentType).toBe("image/png");
    expect(result.kind).toBe("image");
  });

  it("classifies a PDF as a document and uses the document key", async () => {
    const result = await attachFileToEntity({} as never, {
      ...base,
      data: Buffer.from("%PDF-1.4 fake").toString("base64"),
      contentType: "application/pdf",
      filename: "permit.pdf",
    });

    expect(result.kind).toBe("document");
    expect(mocks.uploadToS3).toHaveBeenCalledWith(
      expect.objectContaining({ key: "cubby/documents/permit.pdf" }),
    );
  });

  it("stores a fetched URL image", async () => {
    mocks.fetchExternalResponse.mockResolvedValue(
      new Response(Buffer.from(PNG_BASE64, "base64"), {
        headers: { "content-type": "image/png" },
      }),
    );

    const result = await attachFileToEntity({} as never, {
      ...base,
      url: "https://example.com/photo.png",
    });

    expect(result.kind).toBe("image");
    expect(mocks.uploadToS3).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing target before touching storage", async () => {
    mocks.resolveLiveShortcode.mockResolvedValue(null);

    await expect(
      attachFileToEntity({} as never, {
        ...base,
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow("product PRD-TEST not found");
    expect(mocks.assertAttachableEntityExists).not.toHaveBeenCalled();
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("rejects a target deleted after shortcode resolution before touching storage", async () => {
    mocks.assertAttachableEntityExists.mockRejectedValue(
      new Error("not found"),
    );

    await expect(
      attachFileToEntity({} as never, {
        ...base,
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow("not found");
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("rejects an unsupported content type", async () => {
    await expect(
      attachFileToEntity({} as never, {
        ...base,
        data: Buffer.from("hello").toString("base64"),
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/Unsupported content type/);
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("rolls back the R2 object when the insert+associate transaction fails", async () => {
    // The repo runs insert + associate in one transaction; a throw from either
    // (DB error, or the target deleted mid-flight) rolls back the row, and the
    // service then deletes the now-orphaned R2 object.
    mocks.createAndAssociateUploadedImage.mockRejectedValue(new Error("gone"));

    await expect(
      attachFileToEntity({} as never, {
        ...base,
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow("gone");
    expect(mocks.deleteS3Object).toHaveBeenCalledWith(
      expect.stringContaining("cubby/images/"),
    );
  });

  it("surfaces a blocked/oversized URL fetch as a 4xx, not a 500", async () => {
    mocks.fetchExternalResponse.mockRejectedValue(
      new ExternalFetchError("blocked host", "blocked-url"),
    );

    await expect(
      attachFileToEntity({} as never, {
        ...base,
        url: "https://internal.example/secret.png",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });
});

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
  createOrReuseAttachedImage: vi.fn(),
  findAttachmentByIdempotencyKey: vi.fn(),
  getImageById: vi.fn(),
  deleteImages: vi.fn(),
  getS3Object: vi.fn(),
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
  createOrReuseAttachedImage: mocks.createOrReuseAttachedImage,
  findAttachmentByIdempotencyKey: mocks.findAttachmentByIdempotencyKey,
  getImageById: mocks.getImageById,
  deleteImages: mocks.deleteImages,
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
  getS3Object: mocks.getS3Object,
  getS3ObjectUrl: (key: string) => `https://images.example/${key}`,
  isOurBucketUrl: () => false,
  uploadToS3: mocks.uploadToS3,
}));

vi.mock("@cubby/shared/external-fetch", async (importActual) => ({
  ...(await importActual<typeof import("@cubby/shared/external-fetch")>()),
  fetchExternalResponse: mocks.fetchExternalResponse,
}));

import { imageShortcode } from "@cubby/schemas/identifiers";
import type { McpAttachFileInput } from "@cubby/schemas/image";
import { ExternalFetchError } from "@cubby/shared/external-fetch";
import {
  attachFileToEntity,
  importImageFromUrl,
  initiateDocumentUpload,
} from "./image-storage.service";

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

  /**
   * Regression test: `importImageFromUrlResponseSchema.imageId` is
   * `imageShortcode`, not a raw uuid — a mismatch here would previously only
   * surface as a `strictOutput` 500 on the live upload path, never at
   * typecheck (the repo layer's return type wasn't itself branded), and never
   * in a fast test. Asserting on the SHAPE (parses as `imageShortcode`), not a
   * fixed string, so this doesn't just pin today's mock value.
   */
  it("returns the created image's public IMG- shortcode, not its uuid", async () => {
    mocks.createUploadedImageRecord.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      shortcode: "IMG-7QRS",
    });

    const result = await importImageFromUrl({} as never, {
      sourceUrl: "https://recipes.example/photo.jpg",
      filenamePrefix: "recipe",
    });

    expect(result).not.toBeNull();
    expect(imageShortcode.safeParse(result?.imageId).success).toBe(true);
    expect(result?.imageId).toBe("IMG-7QRS");
    expect(result?.imageId).not.toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("initiateDocumentUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPendingImageRecord.mockResolvedValue({
      id: "22222222-2222-2222-2222-222222222222",
      shortcode: "IMG-2AAA",
    });
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
    // `initiateUploadWithoutEntityResponseSchema.imageId` is `imageShortcode`
    // — this pins the shape (not a raw uuid), same reasoning as the
    // `importImageFromUrl` regression test above.
    expect(imageShortcode.safeParse(result.imageId).success).toBe(true);
    expect(result.imageId).toBe("IMG-2AAA");
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
    mocks.getImageByKey.mockResolvedValue(null);
    mocks.uploadToS3.mockResolvedValue(undefined);
    mocks.deleteS3Object.mockResolvedValue(undefined);
    mocks.createOrReuseAttachedImage.mockImplementation(
      async (
        _db: unknown,
        params: { url: string; filename: string; contentType: string },
      ) => ({
        // `shortcode` too: `attachFileResponse.imageId` is the public `IMG-`
        // code now, so a row without one yields `undefined` downstream.
        row: {
          id: "img-99",
          shortcode: "IMG-9999",
          ...params,
          idempotencyKey: null,
        },
        reused: false,
      }),
    );
    mocks.findAttachmentByIdempotencyKey.mockResolvedValue(null);
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
    expect(result.imageId).toBe("IMG-9999");
    expect(result.reused).toBe(false);
    expect(result.entityId).toBe("PRD-TEST");
    expect(mocks.uploadToS3).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringContaining("cubby/images/"),
        contentType: "image/png",
      }),
    );
    expect(mocks.createOrReuseAttachedImage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ contentType: "image/png", size: 70 }),
      "product",
      "prod-1",
      undefined,
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
      expect.objectContaining({
        key: expect.stringMatching(
          /^cubby\/documents\/PRD-TEST\/permit-[\da-f-]+\.pdf$/,
        ),
      }),
    );
  });

  it("uses the UI collision fallback within the entity folder", async () => {
    mocks.getImageByKey.mockResolvedValueOnce({
      id: "existing",
      url: "https://images.example/x",
      key: "cubby/documents/PRD-TEST/permit.pdf",
    });

    await attachFileToEntity({} as never, {
      ...base,
      data: Buffer.from("%PDF-1.4 fake").toString("base64"),
      contentType: "application/pdf",
      filename: "permit.pdf",
    });

    expect(mocks.uploadToS3).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(
          /^cubby\/documents\/PRD-TEST\/permit-[\da-f-]+\.pdf$/,
        ),
      }),
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

  it("uses the caller content type when a URL response omits it", async () => {
    mocks.fetchExternalResponse.mockResolvedValue(
      new Response(Buffer.from(PNG_BASE64, "base64")),
    );

    const result = await attachFileToEntity({} as never, {
      ...base,
      url: "https://example.com/photo",
      contentType: "image/png",
    });

    expect(result.contentType).toBe("image/png");
    expect(mocks.uploadToS3).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/png" }),
    );
  });

  it("uses the caller content type for a generic URL response MIME", async () => {
    mocks.fetchExternalResponse.mockResolvedValue(
      new Response(Buffer.from(PNG_BASE64, "base64"), {
        headers: { "content-type": "application/octet-stream" },
      }),
    );

    const result = await attachFileToEntity({} as never, {
      ...base,
      url: "https://example.com/photo",
      contentType: "image/png",
    });

    expect(result.contentType).toBe("image/png");
  });

  it("rejects a caller content type that conflicts with a URL response", async () => {
    mocks.fetchExternalResponse.mockResolvedValue(
      new Response(Buffer.from(PNG_BASE64, "base64"), {
        headers: { "content-type": "image/png" },
      }),
    );

    await expect(
      attachFileToEntity({} as never, {
        ...base,
        url: "https://example.com/photo.png",
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow(/conflicts with the URL response Content-Type/);
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("returns an existing idempotency winner before fetching or uploading", async () => {
    mocks.findAttachmentByIdempotencyKey.mockResolvedValueOnce({
      id: "winner-1",
      shortcode: "IMG-7771",
      url: "https://images.example/winner.png",
      filename: "winner.png",
      contentType: "image/png",
      idempotencyKey: "stable-key",
    });

    const result = await attachFileToEntity({} as never, {
      ...base,
      data: PNG_BASE64,
      contentType: "image/png",
      idempotencyKey: "stable-key",
    });

    expect(result.imageId).toBe("IMG-7771");
    expect(result.reused).toBe(true);
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("cleans only the losing object when the transactional idempotency check elects another winner", async () => {
    mocks.createOrReuseAttachedImage.mockResolvedValueOnce({
      row: {
        id: "winner-2",
        shortcode: "IMG-7772",
        url: "https://images.example/winner.png",
        filename: "winner.png",
        contentType: "image/png",
        idempotencyKey: "race-key",
      },
      reused: true,
    });

    const result = await attachFileToEntity({} as never, {
      ...base,
      data: PNG_BASE64,
      contentType: "image/png",
      idempotencyKey: "race-key",
    });

    expect(result.imageId).toBe("IMG-7772");
    expect(result.reused).toBe(true);
    expect(mocks.deleteS3Object).toHaveBeenCalledWith(
      expect.stringContaining("cubby/images/"),
    );
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

  // The staged-upload mode discards its staging row on success, and
  // `deleteImages` is a HARD delete that takes the row's entity associations
  // with it. So an `uploadId` naming an already-attached image would duplicate
  // the attachment and then destroy the original — and that mixup is easy to
  // make, since `attach_file` returns an `imageId` and `create_file_upload`
  // returns an `uploadId`, both bare uuids over the same table.
  describe("uploadId mode", () => {
    const stagedRow = {
      id: "upl-1",
      key: "cubby/images/staged.png",
      filename: "staged.png",
      contentType: "image/png",
      status: "PENDING",
      entityType: null,
    };

    it("attaches a staged upload and cleans up its staging row", async () => {
      mocks.getImageById.mockResolvedValue(stagedRow);
      mocks.getS3Object.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from(PNG_BASE64, "base64"),
      });
      mocks.deleteImages.mockResolvedValue({
        deletedIds: ["upl-1"],
        deletedKeys: ["cubby/images/staged.png"],
      });

      const result = await attachFileToEntity({} as never, {
        ...base,
        uploadId: "upl-1",
      });

      expect(result.kind).toBe("image");
      expect(mocks.deleteImages).toHaveBeenCalledWith({}, ["upl-1"]);
    });

    it("refuses an uploadId that names an already-attached image", async () => {
      mocks.getImageById.mockResolvedValue({
        ...stagedRow,
        status: "UPLOADED",
        entityType: "PRODUCT",
      });

      await expect(
        attachFileToEntity({} as never, { ...base, uploadId: "img-existing" }),
      ).rejects.toThrow(/not a staged upload/);

      // The point of the guard: nothing is uploaded, and above all the
      // already-attached image is NOT hard-deleted by the cleanup step.
      expect(mocks.getS3Object).not.toHaveBeenCalled();
      expect(mocks.uploadToS3).not.toHaveBeenCalled();
      expect(mocks.deleteImages).not.toHaveBeenCalled();
    });

    it("names create_file_upload when the uploadId does not exist", async () => {
      mocks.getImageById.mockRejectedValue(
        Object.assign(new Error("Image not found"), {
          cause: { reason: "IMAGE_NOT_FOUND" },
        }),
      );

      await expect(
        attachFileToEntity({} as never, { ...base, uploadId: "upl-missing" }),
      ).rejects.toThrow(/Call create_file_upload first/);
    });

    it("propagates a non-not-found lookup failure unchanged", async () => {
      mocks.getImageById.mockRejectedValue(new Error("database unavailable"));

      await expect(
        attachFileToEntity({} as never, { ...base, uploadId: "upl-1" }),
      ).rejects.toThrow("database unavailable");
    });

    it("refuses a row that is unassociated but already marked uploaded", async () => {
      // A standalone `/images` upload that `markUploaded` flipped. It is nobody's
      // staging row, so consuming it would still hard-delete a real file.
      mocks.getImageById.mockResolvedValue({
        ...stagedRow,
        status: "UPLOADED",
      });

      await expect(
        attachFileToEntity({} as never, {
          ...base,
          uploadId: "img-standalone",
        }),
      ).rejects.toThrow(/not a staged upload/);
      expect(mocks.deleteImages).not.toHaveBeenCalled();
    });
  });

  it("rolls back the R2 object when the insert+associate transaction fails", async () => {
    // The repo runs insert + associate in one transaction; a throw from either
    // (DB error, or the target deleted mid-flight) rolls back the row, and the
    // service then deletes the now-orphaned R2 object.
    mocks.createOrReuseAttachedImage.mockRejectedValue(new Error("gone"));

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

import { imageShortcode } from "@cubby/schemas/identifiers";
import {
  createFileUploadResponse,
  type McpAttachFileInput,
} from "@cubby/schemas/image";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { ExternalFetchError } from "@cubby/shared/external-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImageStorageService,
  type ImageStoragePorts,
} from "./image-storage.service";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type TestDatabase = { readonly scope: "image-storage" };
const database: TestDatabase = { scope: "image-storage" };
const stagedImageId = testEntityId("image", "staged-upload");
const attachmentPendingImageId = testEntityId("image", "attachment-pending");
const productId = testEntityId("product", "attachment-target");
const stagedUploadCode = testShortcode("image", "IMG-2222");
const existingImageCode = testShortcode("image", "IMG-3333");

class MemoryImageStorage {
  readonly createdPending: Array<{
    filename: string;
    contentType: string;
    size: number;
    key: string;
    perceptualHash?: string;
    sourceFingerprint?: { hash: string; aspectRatio: number };
    width?: number;
    height?: number;
  }> = [];
  readonly createdUploads: Array<{
    filename: string;
    contentType: string;
    size: number;
    key: string;
  }> = [];
  readonly uploaded: Array<{ key: string; contentType: string; size: number }> =
    [];
  readonly deletedKeys: string[] = [];
  /** Hours passed to each `cullPendingImages` call, in order. */
  readonly culls: number[] = [];
  /** Keys the next cull reports as abandoned. */
  cullable: string[] = [];
  cullError: Error | null = null;
  readonly resolvedCodes = new Map<string, string>([
    [stagedUploadCode, stagedImageId],
    [existingImageCode, testEntityId("image", "existing-image")],
  ]);
  imageByKey: { shortcode: string; key: string; url: string } | null = null;
  isOurBucket = false;
  stagedRow:
    | {
        key: string;
        filename: string;
        contentType: string;
        status: string;
        entityType: string | null;
      }
    | Error = {
    key: "cubby/images/staged.png",
    filename: "staged.png",
    contentType: "image/png",
    status: "PENDING",
    entityType: null,
  };
  stagedObject: Response = new Response(Buffer.from(PNG_BASE64, "base64"));
  fetchedResponse: Response | Error = new Response(
    Buffer.from(PNG_BASE64, "base64"),
    { headers: { "content-type": "image/png" } },
  );
  imported: {
    key: string;
    url: string;
    contentType: string;
    size: number;
  } | null = {
    key: "imports/recipe.jpg",
    url: "https://images.example/imports/recipe.jpg",
    contentType: "image/jpeg",
    size: 123,
  };
  createUploadError: Error | null = null;
  createAttachmentError: Error | null = null;
  deleteObjectError: Error | null = null;
  uploadError: Error | null = null;
  attachableEntityError: Error | null = null;
  existingAttachment: {
    shortcode: string;
    key: string;
    filename: string;
    contentType: string;
    idempotencyKey: string | null;
  } | null = null;
  reuseAttachment = false;
  deletedImageIds: string[] = [];
  publishedMetadataExtractions: { imageId: string; contentType: string }[] = [];

  readonly ports: ImageStoragePorts<TestDatabase> = {
    repository: {
      assertAttachableEntityExists: async () => {
        if (this.attachableEntityError) throw this.attachableEntityError;
      },
      createOrReuseAttachedImage: async (_database, params) => {
        if (this.createAttachmentError) throw this.createAttachmentError;
        const row = this.existingAttachment ?? {
          shortcode: "IMG-9999",
          key: params.key,
          filename: params.filename,
          contentType: params.contentType,
          idempotencyKey: params.idempotencyKey ?? null,
        };
        return { row, reused: this.reuseAttachment };
      },
      createPendingImageRecord: async (_database, params) => {
        this.createdPending.push(params);
        return { id: attachmentPendingImageId, shortcode: "IMG-2AAA" };
      },
      createUploadedImageRecord: async (_database, params) => {
        if (this.createUploadError) throw this.createUploadError;
        this.createdUploads.push(params);
        return { id: testEntityId("image", "uploaded"), shortcode: "IMG-7QRS" };
      },
      cullPendingImages: async (_database, olderThanHours) => {
        if (this.cullError) throw this.cullError;
        this.culls.push(olderThanHours);
        return {
          count: this.cullable.length,
          deletedIds: this.cullable.map((key) => testEntityId("image", key)),
          deletedKeys: this.cullable,
        };
      },
      deleteImages: async (_database, imageIds) => {
        this.deletedImageIds.push(...imageIds);
        return {
          deletedIds: imageIds,
          deletedKeys: ["cubby/images/staged.png"],
        };
      },
      findAttachmentByIdempotencyKey: async () => this.existingAttachment,
      getImageById: async () => {
        if (this.stagedRow instanceof Error) throw this.stagedRow;
        return this.stagedRow;
      },
      getImageByKey: async () => this.imageByKey,
    },
    objectStorage: {
      contentTypeToExtension: (contentType) =>
        contentType === "image/png" ? "png" : "jpg",
      deleteObject: async (key) => {
        if (this.deleteObjectError) throw this.deleteObjectError;
        this.deletedKeys.push(key);
      },
      extractKeyFromUrl: () => "cubby/images/existing.jpg",
      fetchAndStoreImage: async () => this.imported,
      generateDocumentKey: (filename, folder) =>
        `cubby/documents/${folder ? `${folder}/` : ""}${filename}`,
      generateImageKey: (filename) => `cubby/images/${filename}`,
      generatePresignedUploadUrl: async () => "https://r2.example/put",
      getObject: async () => this.stagedObject,
      getPublicUrl: (key) => `https://images.example/${key}`,
      isOurBucketUrl: () => this.isOurBucket,
      upload: async ({ key, body, contentType }) => {
        if (this.uploadError) throw this.uploadError;
        this.uploaded.push({ key, contentType, size: body.length });
      },
    },
    externalFetch: {
      fetchResponse: async () => {
        if (this.fetchedResponse instanceof Error) throw this.fetchedResponse;
        return this.fetchedResponse.clone();
      },
      readResponseWithLimit: async (response) =>
        new Uint8Array(await response.arrayBuffer()),
      sanitizeUrl: (url) => new URL(url).toString(),
      validateUrl: (url) => new URL(url),
    },
    shortcode: {
      resolveLive: async (_database, code, entity) =>
        entity === "image"
          ? (this.resolvedCodes.get(code) ?? null)
          : code === "PRD-TEST"
            ? productId
            : null,
    },
    backgroundTasks: {
      publishImageMetadataExtraction: async (
        _database,
        imageId,
        contentType,
      ) => {
        this.publishedMetadataExtractions.push({ imageId, contentType });
      },
    },
  };
}

function setup() {
  const storage = new MemoryImageStorage();
  return { storage, service: createImageStorageService(storage.ports) };
}

const attachmentTarget = {
  entityType: "product",
  entityId: "PRD-TEST",
} satisfies Pick<McpAttachFileInput, "entityType" | "entityId">;

describe("image storage ports", () => {
  it("persists optional native hash metadata on the pending upload row", async () => {
    const { service, storage } = setup();

    await service.initiateImageUploadWithoutEntity(database, {
      filename: "native.jpg",
      contentType: "image/jpeg",
      size: 1024,
      algorithmRevision: 1,
      perceptualHash: "0123456789abcdef",
      sourceFingerprint: { hash: "fedcba9876543210", aspectRatio: 1.5 },
      width: 1200,
      height: 800,
    });

    expect(storage.createdPending).toEqual([
      expect.objectContaining({
        perceptualHash: "0123456789abcdef",
        sourceFingerprint: { hash: "fedcba9876543210", aspectRatio: 1.5 },
        width: 1200,
        height: 800,
      }),
    ]);
  });

  it("rolls back an imported object when the repository rejects its image row", async () => {
    const { service, storage } = setup();
    storage.createUploadError = new Error("database unavailable");

    await expect(
      service.importImageFromUrl(database, {
        sourceUrl: "https://recipes.example/photo.jpg",
        filenamePrefix: "recipe",
      }),
    ).rejects.toThrow("database unavailable");
    expect(storage.deletedKeys).toEqual(["imports/recipe.jpg"]);
  });

  it("returns an IMG shortcode from an imported image", async () => {
    const { service } = setup();

    const result = await service.importImageFromUrl(database, {
      sourceUrl: "https://recipes.example/photo.jpg",
      filenamePrefix: "recipe",
    });

    expect(imageShortcode.safeParse(result?.imageId).success).toBe(true);
    expect(result?.imageId).toBe("IMG-7QRS");
    expect(result?.created).toBe(true);
  });

  it("marks a same-bucket existing image as not created", async () => {
    const { service, storage } = setup();
    storage.isOurBucket = true;
    storage.imageByKey = {
      shortcode: testShortcode("image", "IMG-OLD1"),
      key: "cubby/images/existing.jpg",
      url: "https://images.example/cubby/images/existing.jpg",
    };

    const result = await service.importImageFromUrl(database, {
      sourceUrl: "https://images.example/cubby/images/existing.jpg",
      filenamePrefix: "product-enrichment",
    });

    expect(result).toMatchObject({
      imageId: testShortcode("image", "IMG-OLD1"),
      created: false,
    });
    expect(storage.createdUploads).toHaveLength(0);
  });

  it("allocates a readable document key and dedupes collisions", async () => {
    const { service, storage } = setup();
    storage.imageByKey = {
      shortcode: "IMG-OLD1",
      key: "cubby/documents/P-0123/blender-manual.pdf",
      url: "https://images.example/old",
    };

    const result = await service.initiateDocumentUpload(database, {
      filename: "blender-manual.pdf",
      contentType: "application/pdf",
      size: 1024,
      entityType: "PRODUCT",
      folder: "P-0123",
    });

    expect(result.key).toMatch(
      /^cubby\/documents\/P-0123\/blender-manual-\d+\.pdf$/,
    );
    expect(storage.createdPending).toHaveLength(1);
  });

  it("stages only accepted upload types and returns the declared MCP shape", async () => {
    const { service, storage } = setup();

    const result = await service.createFileUpload(database, {
      entityId: "PRD-TEST",
      filename: "receipt.jpeg",
      contentType: "image/jpeg",
      size: 2_432_267,
    });

    expect(createFileUploadResponse.safeParse(result).success).toBe(true);
    await expect(
      service.createFileUpload(database, {
        entityId: "PRD-TEST",
        filename: "notes.txt",
        contentType: "text/plain",
        size: 12,
      }),
    ).rejects.toThrow(/Unsupported content type/);
    expect(storage.createdPending).toHaveLength(1);
  });

  it("culls day-old abandoned uploads on the next presign and deletes their objects", async () => {
    const { service, storage } = setup();
    storage.cullable = ["cubby/images/abandoned.png"];

    await service.createFileUpload(database, {
      entityId: "PRD-TEST",
      filename: "receipt.jpeg",
      contentType: "image/jpeg",
      size: 2_432_267,
    });

    // Clean-on-write replaces the sweeper: one bounded cull per presign,
    // before the new PENDING row is minted.
    expect(storage.culls).toEqual([24]);
    expect(storage.deletedKeys).toContain("cubby/images/abandoned.png");
    expect(storage.createdPending).toHaveLength(1);
  });

  it("still presigns when the cull fails", async () => {
    const { service, storage } = setup();
    storage.cullError = new Error("cull unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await service.createFileUpload(database, {
      entityId: "PRD-TEST",
      filename: "receipt.jpeg",
      contentType: "image/jpeg",
      size: 2_432_267,
    });

    expect(storage.createdPending).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      "image.cull-on-presign.failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

describe("attachFileToEntity", () => {
  let service: ReturnType<typeof setup>["service"];
  let storage: MemoryImageStorage;

  beforeEach(() => {
    ({ service, storage } = setup());
  });

  it("stores base64 image data and reports its public attachment", async () => {
    const result = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      data: PNG_BASE64,
      contentType: "image/png",
    });

    expect(result).toMatchObject({
      imageId: "IMG-9999",
      kind: "image",
      reused: false,
    });
    expect(storage.uploaded).toEqual([
      expect.objectContaining({
        key: "cubby/images/attachment.png",
        contentType: "image/png",
      }),
    ]);
  });

  it("registers a pending row before upload so interrupted work is sweepable", async () => {
    storage.uploadError = new Error("upload interrupted");
    storage.deleteObjectError = new Error("object store unavailable");

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow(/partial object could not be cleaned up/);
    expect(storage.createdPending).toHaveLength(1);
    expect(storage.deletedImageIds).toEqual([]);
  });

  it("parses data URI content types and classifies PDFs as documents", async () => {
    const image = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      data: `data:image/png;base64,${PNG_BASE64}`,
    });
    const document = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      data: Buffer.from("%PDF-1.4 fake").toString("base64"),
      contentType: "application/pdf",
      filename: "permit.pdf",
    });

    expect(image.contentType).toBe("image/png");
    expect(document.kind).toBe("document");
    expect(storage.uploaded[1]?.key).toMatch(
      /^cubby\/documents\/PRD-TEST\/permit-[\da-f-]+\.pdf$/,
    );
  });

  it("uses the URL response type, rejects conflicts, and maps blocked fetches", async () => {
    storage.fetchedResponse = new Response(Buffer.from(PNG_BASE64, "base64"), {
      headers: { "content-type": "image/png" },
    });
    const result = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      url: "https://example.com/photo.png",
    });
    expect(result.contentType).toBe("image/png");

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        url: "https://example.com/photo.png",
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow(/conflicts with the URL response Content-Type/);

    storage.fetchedResponse = new ExternalFetchError(
      "blocked host",
      "blocked-url",
    );
    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        url: "https://internal.example/secret.png",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reuses an idempotency winner before writing an object", async () => {
    storage.existingAttachment = {
      shortcode: "IMG-7QRS",
      key: "cubby/images/winner.png",
      filename: "winner.png",
      contentType: "image/png",
      idempotencyKey: "stable-key",
    };

    const result = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      data: PNG_BASE64,
      contentType: "image/png",
      idempotencyKey: "stable-key",
    });

    expect(result.reused).toBe(true);
    expect(storage.uploaded).toEqual([]);
  });

  it("removes only a losing idempotent object after the repository elects a winner", async () => {
    storage.reuseAttachment = true;

    await service.attachFileToEntity(database, {
      ...attachmentTarget,
      data: PNG_BASE64,
      contentType: "image/png",
      idempotencyKey: "race-key",
    });

    expect(storage.deletedKeys).toEqual(["cubby/images/attachment.png"]);
  });

  it("reports when a losing idempotent upload cannot be removed", async () => {
    storage.reuseAttachment = true;
    storage.deleteObjectError = new Error("object store unavailable");

    const result = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      data: PNG_BASE64,
      contentType: "image/png",
      idempotencyKey: "race-key",
    });

    expect(result.reused).toBe(true);
    expect(result.cleanupWarning).toMatch(/redundant upload/);
  });

  it("consumes a pending staged upload and deletes its staging row", async () => {
    const result = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      uploadId: stagedUploadCode,
    });

    expect(result.kind).toBe("image");
    expect(storage.deletedImageIds).toEqual([stagedImageId]);
    expect(storage.deletedKeys).toContain("cubby/images/staged.png");
  });

  it("reports when a consumed staged upload object cannot be removed", async () => {
    storage.deleteObjectError = new Error("object store unavailable");

    const result = await service.attachFileToEntity(database, {
      ...attachmentTarget,
      uploadId: stagedUploadCode,
    });

    expect(result.reused).toBe(false);
    expect(result.cleanupWarning).toMatch(/staged upload/);
  });

  it("rejects a missing attachment target before writing an object", async () => {
    // Target validation precedes R2 work, so a bad shortcode cannot orphan an
    // object that has no database association.
    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        entityId: "PRD-MISSING",
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow("product PRD-MISSING not found");
    expect(storage.uploaded).toEqual([]);
  });

  it("removes no object when the target disappears after resolution", async () => {
    // The repository re-checks liveness under its transaction/row lock; this
    // simulates that second check failing after shortcode resolution.
    storage.attachableEntityError = new Error("target was deleted");

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow("target was deleted");
    expect(storage.uploaded).toEqual([]);
  });

  it("rejects unsupported content types on the attach path before writing", async () => {
    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        data: PNG_BASE64,
        contentType: "text/plain",
      }),
    ).rejects.toThrow("Unsupported content type: text/plain");
    expect(storage.uploaded).toEqual([]);
  });

  it("maps a row deleted after shortcode resolution to the staged-upload error", async () => {
    // Resolution and the UUID row read are separate operations; the row may
    // disappear between them and should look like an expired staged upload.
    storage.stagedRow = new Error("Image not found", {
      cause: { reason: "IMAGE_NOT_FOUND" },
    });

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        uploadId: stagedUploadCode,
      }),
    ).rejects.toThrow("Call create_file_uploads first");
    expect(storage.uploaded).toEqual([]);
  });

  it("preserves non-not-found staged-row lookup failures", async () => {
    storage.stagedRow = new Error("database unavailable");

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        uploadId: stagedUploadCode,
      }),
    ).rejects.toThrow("database unavailable");
    expect(storage.uploaded).toEqual([]);
  });

  it("refuses an attached or missing uploadId without writing a new object", async () => {
    storage.stagedRow = {
      key: "cubby/images/existing.png",
      filename: "existing.png",
      contentType: "image/png",
      status: "UPLOADED",
      entityType: "PRODUCT",
    };
    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        uploadId: existingImageCode,
      }),
    ).rejects.toThrow(/not a staged upload/);

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        uploadId: testShortcode("image", "IMG-4444"),
      }),
    ).rejects.toThrow(/Call create_file_uploads first/);
    expect(storage.uploaded).toEqual([]);
  });

  it("refuses a standalone uploaded row as a staged upload", async () => {
    storage.stagedRow = {
      key: "cubby/images/standalone.png",
      filename: "standalone.png",
      contentType: "image/png",
      status: "UPLOADED",
      entityType: null,
    };

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        uploadId: stagedUploadCode,
      }),
    ).rejects.toThrow(/not a staged upload/);
    expect(storage.uploaded).toEqual([]);
  });

  it("removes an orphaned object when the association transaction fails", async () => {
    storage.createAttachmentError = new Error("gone");

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow("gone");
    expect(storage.deletedKeys).toEqual(["cubby/images/attachment.png"]);
  });

  it("surfaces both attachment and rollback failures", async () => {
    storage.createAttachmentError = new Error("database unavailable");
    storage.deleteObjectError = new Error("object store unavailable");

    await expect(
      service.attachFileToEntity(database, {
        ...attachmentTarget,
        data: PNG_BASE64,
        contentType: "image/png",
      }),
    ).rejects.toThrow(
      "File attachment failed and its uploaded object could not be cleaned up",
    );
  });
});

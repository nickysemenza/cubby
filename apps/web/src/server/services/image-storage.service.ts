import type {
  AttachFileResponse,
  InitiateDocumentUploadInput,
  InitiateUploadWithoutEntityInput,
  McpAttachFileInput,
} from "@cubby/schemas/image";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
  PDF_CONTENT_TYPE,
} from "@cubby/schemas/image";
import {
  ExternalFetchError,
  fetchExternalResponse,
  readResponseWithLimit,
  sanitizeExternalUrl,
  validateExternalHttpUrl,
} from "@cubby/shared/external-fetch";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  assertAttachableEntityExists,
  createOrReuseAttachedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
  cullPendingImages,
  deleteImages,
  findAttachmentByIdempotencyKey,
  getImageByKey,
} from "~/server/repo/image";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  filenameForContentType,
  inspectImageFile,
} from "~/server/services/image-integrity";
import {
  contentTypeToExtension,
  deleteS3Object,
  extractKeyFromUrl,
  fetchAndStoreImage,
  generateDocumentKey,
  generateImageKey,
  generatePresignedUploadUrl,
  getS3ObjectUrl,
  isOurBucketUrl,
  uploadToS3,
} from "~/server/utils/s3";

// Shared by the image and document initiation paths — creates the PENDING row
// and presigns the PUT. Content-type agnostic; the zod input schemas gate what
// each endpoint accepts.
const initiatePendingUpload = async (
  db: Database,
  input: { filename: string; contentType: string; size: number },
  key: string,
) => {
  const url = getS3ObjectUrl(key);
  const createdImage = await createPendingImageRecord(db, {
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    key,
    url,
  });
  const uploadUrl = await generatePresignedUploadUrl({
    key,
    contentType: input.contentType,
  });

  return {
    uploadUrl,
    imageId: createdImage.id,
    key,
    url,
  };
};

// Allocate readable document keys consistently for every upload path. When a
// folder is supplied, it is the owning entity's public shortcode. The image
// table is authoritative for collisions and includes soft-deleted rows, whose
// R2 objects may still exist.
const allocateDocumentKey = async (
  db: Database,
  filename: string,
  folder?: string,
): Promise<string> => {
  let key = generateDocumentKey(filename, folder);
  if (await getImageByKey(db, key)) {
    const dot = filename.lastIndexOf(".");
    const deduped =
      dot > 0
        ? `${filename.slice(0, dot)}-${Date.now()}${filename.slice(dot)}`
        : `${filename}-${Date.now()}`;
    key = generateDocumentKey(deduped, folder);
  }
  return key;
};

// Server-side MCP attempts may race and a losing attempt is required to delete
// only its own object. Unlike browser document uploads, readable keys are not
// worth sharing here: append a UUID before allocation to make that guarantee.
const allocateAttachmentDocumentKey = async (
  db: Database,
  filename: string,
  folder: string,
): Promise<string> => {
  const dot = filename.lastIndexOf(".");
  const attemptFilename =
    dot > 0
      ? `${filename.slice(0, dot)}-${crypto.randomUUID()}${filename.slice(dot)}`
      : `${filename}-${crypto.randomUUID()}`;
  return await allocateDocumentKey(db, attemptFilename, folder);
};

export const initiateImageUploadWithoutEntity = async (
  db: Database,
  input: InitiateUploadWithoutEntityInput,
) => {
  return initiatePendingUpload(db, input, generateImageKey(input.filename));
};

export const initiateDocumentUpload = async (
  db: Database,
  input: InitiateDocumentUploadInput,
) => {
  const key = await allocateDocumentKey(db, input.filename, input.folder);
  return initiatePendingUpload(db, input, key);
};

export const importImageFromUrl = async (
  db: Database,
  params: { sourceUrl: string; filenamePrefix: string },
): Promise<{ imageId: string; key: string; url: string } | null> => {
  if (isOurBucketUrl(params.sourceUrl)) {
    const key = extractKeyFromUrl(params.sourceUrl);
    if (key) {
      const existing = await getImageByKey(db, key);
      if (existing) {
        return { imageId: existing.id, key: existing.key, url: existing.url };
      }

      const createdImage = await createUploadedImageRecord(db, {
        key,
        filename: params.filenamePrefix,
        size: 0,
        contentType: "application/octet-stream",
        url: params.sourceUrl,
      });
      return { imageId: createdImage.id, key, url: params.sourceUrl };
    }
  }

  validateExternalHttpUrl(params.sourceUrl);

  const stored = await fetchAndStoreImage(
    params.sourceUrl,
    params.filenamePrefix,
  );
  if (!stored) {
    return null;
  }

  let createdImage: Awaited<ReturnType<typeof createUploadedImageRecord>>;
  try {
    createdImage = await createUploadedImageRecord(db, {
      key: stored.key,
      filename: `${params.filenamePrefix}.${contentTypeToExtension(stored.contentType)}`,
      size: stored.size,
      contentType: stored.contentType,
      url: stored.url,
    });
  } catch (error) {
    await deleteS3Object(stored.key).catch((cleanupError) => {
      console.error("Failed to roll back imported image object:", cleanupError);
    });
    throw error;
  }

  return { imageId: createdImage.id, key: stored.key, url: stored.url };
};

// `data:<type>;base64,<payload>` — capture the (optional) inline type, the
// base64 marker, and the payload. Only base64 data: URIs are supported.
const DATA_URI_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

/** Decode a base64 payload (raw or a `data:` URI) into bytes + any inline type. */
function decodeBase64File(
  data: string,
  fallbackContentType: string | undefined,
): { bytes: Buffer; contentType: string | undefined } {
  const match = DATA_URI_RE.exec(data.trim());
  if (match) {
    const [, inlineType, base64Flag, payload] = match;
    if (!base64Flag) {
      throw createAppError(
        "IMAGE_ATTACH_FAILED",
        "Only base64 data: URIs are supported",
      );
    }
    if (
      inlineType &&
      fallbackContentType &&
      inlineType.toLowerCase() !== fallbackContentType.toLowerCase()
    ) {
      throw createAppError(
        "IMAGE_ATTACH_FAILED",
        "Data URI content type conflicts with contentType",
      );
    }
    return {
      bytes: Buffer.from(payload ?? "", "base64"),
      contentType: inlineType || fallbackContentType,
    };
  }
  return {
    bytes: Buffer.from(data, "base64"),
    contentType: fallbackContentType,
  };
}

/**
 * Store a file (base64 bytes OR a fetched URL) in R2 and associate it with a
 * product / recipe / location / project. Server-side PUT only — the browser's
 * two-phase presigned flow is unusable from a JSON MCP client. Unlike
 * {@link importImageFromUrl} (image-only), this also accepts PDFs, so it drives
 * the bytes path directly rather than reusing that helper.
 */
export const attachFileToEntity = async (
  db: Database,
  input: McpAttachFileInput,
): Promise<AttachFileResponse> => {
  // Fail a bad target id before we touch R2, so we never orphan an object.
  const entityId = await resolveLiveShortcode(
    db,
    input.entityId,
    input.entityType,
  );
  if (!entityId) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${input.entityType} ${input.entityId} not found`,
    );
  }
  await assertAttachableEntityExists(db, input.entityType, entityId);

  // A cheap retry can return before fetching/uploading bytes. The same lookup
  // runs under the target-row lock in the repo to close the upload race.
  if (input.idempotencyKey) {
    const existing = await findAttachmentByIdempotencyKey(
      db,
      input.entityType,
      entityId,
      input.idempotencyKey,
    );
    if (existing) {
      return {
        imageId: existing.id,
        url: existing.url,
        filename: existing.filename,
        contentType: existing.contentType,
        kind: existing.contentType === PDF_CONTENT_TYPE ? "document" : "image",
        entityType: input.entityType,
        entityId: input.entityId,
        idempotencyKey: existing.idempotencyKey,
      };
    }
  }

  // 1. Resolve bytes + content type + filename from whichever input mode.
  let bytes: Buffer;
  let contentType: string | undefined;
  let sourceFilename: string | undefined;

  if (input.data) {
    ({ bytes, contentType } = decodeBase64File(input.data, input.contentType));
  } else if (input.url) {
    try {
      const url = validateExternalHttpUrl(input.url);
      const response = await fetchExternalResponse(url);
      if (!response.ok) {
        throw createAppError(
          "IMAGE_ATTACH_FAILED",
          `Failed to fetch ${sanitizeExternalUrl(url)}: ${response.status}`,
        );
      }
      bytes = Buffer.from(
        await readResponseWithLimit(response, MAX_IMAGE_UPLOAD_BYTES),
      );
      const responseContentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim();
      if (
        input.contentType &&
        responseContentType &&
        input.contentType.toLowerCase() !== responseContentType.toLowerCase()
      ) {
        throw createAppError(
          "IMAGE_ATTACH_FAILED",
          "contentType conflicts with the URL response Content-Type",
        );
      }
      contentType = responseContentType;
      sourceFilename = new URL(url).pathname.split("/").pop() || undefined;
    } catch (error) {
      // Bad/SSRF-blocked URL, redirect limit, oversized body — a caller error,
      // so surface it as a 4xx instead of letting the router rewrap it as a 500.
      if (error instanceof ExternalFetchError) {
        throw createAppError("IMAGE_ATTACH_FAILED", error.message, error);
      }
      throw error;
    }
  } else {
    // Unreachable: mcpAttachFileInput.refine enforces exactly one of url/data.
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "Provide exactly one of `url` or `data`",
    );
  }

  if (!contentType) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "contentType is required for base64 data (or use a data: URI)",
    );
  }
  contentType = contentType.toLowerCase();

  // 2. Classify (a "document" is just a PDF) + validate against the allowlists.
  const isDocument = contentType === PDF_CONTENT_TYPE;
  const isAllowed =
    isDocument ||
    (ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType);
  if (!isAllowed) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `Unsupported content type: ${contentType}`,
    );
  }
  if (bytes.length === 0) {
    throw createAppError("IMAGE_ATTACH_FAILED", "File is empty");
  }
  if (bytes.length > MAX_IMAGE_UPLOAD_BYTES) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `File exceeds ${MAX_IMAGE_UPLOAD_BYTES} bytes`,
    );
  }

  const inspected = await inspectImageFile(bytes, contentType);

  // 3. Store in R2, then record the row — rolling back the object if the DB
  // insert fails (mirrors importImageFromUrl).
  const extension = isDocument ? "pdf" : contentTypeToExtension(contentType);
  const filename = filenameForContentType(
    input.filename ?? sourceFilename ?? `attachment.${extension}`,
    contentType,
  );
  const key = isDocument
    ? await allocateAttachmentDocumentKey(db, filename, input.entityId)
    : generateImageKey(filename);

  await uploadToS3({ key, body: bytes, contentType });
  const url = getS3ObjectUrl(key);

  // 4. Insert the row + associate in one transaction (owned by the repo), so a
  // failure in either step (e.g. the target was deleted since step 0) rolls back
  // the DB write; the catch then removes the now-orphaned R2 object.
  let created: Awaited<ReturnType<typeof createOrReuseAttachedImage>>;
  try {
    created = await createOrReuseAttachedImage(
      db,
      {
        key,
        url,
        filename,
        size: bytes.length,
        ...inspected,
        idempotencyKey: input.idempotencyKey,
        expectedImageCount: input.expectedImageCount,
      },
      input.entityType,
      entityId,
      input.documentKind,
    );
  } catch (error) {
    await deleteS3Object(key).catch((cleanupError) => {
      console.error("Failed to roll back attached file object:", cleanupError);
    });
    throw error;
  }

  if (created.reused) {
    await deleteS3Object(key).catch((cleanupError) => {
      console.error(
        "Failed to remove losing idempotent attachment object:",
        cleanupError,
      );
    });
  }

  return {
    imageId: created.row.id,
    url: created.row.url,
    filename: created.row.filename,
    contentType: created.row.contentType,
    kind: created.row.contentType === PDF_CONTENT_TYPE ? "document" : "image",
    entityType: input.entityType,
    entityId: input.entityId,
    idempotencyKey: created.row.idempotencyKey,
  };
};

/** Best-effort R2 cleanup for rows already removed from the DB. A failed object
 * delete only strands bytes in the bucket — never fail the mutation over it. */
const deleteStoredObjects = async (keys: string[]): Promise<void> => {
  for (const key of keys) {
    try {
      await deleteS3Object(key);
    } catch (error) {
      console.error("Error deleting image from R2:", error);
    }
  }
};

export const cullPendingImageStorage = async (
  db: Database,
  olderThanHours: number,
) => {
  const result = await cullPendingImages(db, olderThanHours);
  await deleteStoredObjects(result.deletedKeys);
  return result;
};

/**
 * Delete images outright: the DB rows (plus their entity associations) in one
 * transaction, then their R2 objects. The DB is the source of truth — an object
 * that fails to delete is logged and left behind rather than blocking the row
 * removal (same contract as the pending cull).
 */
export const deleteImagesWithStorage = async (
  db: Database,
  imageIds: string[],
) => {
  const result = await deleteImages(db, imageIds);
  await deleteStoredObjects(result.deletedKeys);
  return result;
};

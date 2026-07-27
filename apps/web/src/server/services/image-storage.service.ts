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
  createAndAssociateUploadedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
  cullPendingImages,
  deleteImages,
  getImageByKey,
} from "~/server/repo/image";
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
  // Document keys preserve the original filename, so a re-upload of the same
  // name in the same folder would silently overwrite the R2 object (which a
  // soft-deleted row may still reference). Fall back to a timestamped key on
  // collision — getImageByKey deliberately includes soft-deleted rows.
  let key = generateDocumentKey(input.filename, input.folder);
  if (await getImageByKey(db, key)) {
    const dot = input.filename.lastIndexOf(".");
    const deduped =
      dot > 0
        ? `${input.filename.slice(0, dot)}-${Date.now()}${input.filename.slice(dot)}`
        : `${input.filename}-${Date.now()}`;
    key = generateDocumentKey(deduped, input.folder);
  }
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
  await assertAttachableEntityExists(db, input.entityType, input.entityId);

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
      contentType =
        input.contentType ??
        response.headers.get("content-type")?.split(";", 1)[0]?.trim();
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

  // 3. Store in R2, then record the row — rolling back the object if the DB
  // insert fails (mirrors importImageFromUrl).
  const extension = isDocument ? "pdf" : contentTypeToExtension(contentType);
  const filename =
    input.filename ?? sourceFilename ?? `attachment.${extension}`;
  const key = isDocument
    ? generateDocumentKey(filename)
    : generateImageKey(filename);

  await uploadToS3({ key, body: bytes, contentType });
  const url = getS3ObjectUrl(key);

  // 4. Insert the row + associate in one transaction (owned by the repo), so a
  // failure in either step (e.g. the target was deleted since step 0) rolls back
  // the DB write; the catch then removes the now-orphaned R2 object.
  let created: Awaited<ReturnType<typeof createAndAssociateUploadedImage>>;
  try {
    created = await createAndAssociateUploadedImage(
      db,
      { key, url, filename, contentType, size: bytes.length },
      input.entityType,
      input.entityId,
    );
  } catch (error) {
    await deleteS3Object(key).catch((cleanupError) => {
      console.error("Failed to roll back attached file object:", cleanupError);
    });
    throw error;
  }

  return {
    imageId: created.id,
    url,
    filename,
    contentType,
    kind: isDocument ? "document" : "image",
    entityType: input.entityType,
    entityId: input.entityId,
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

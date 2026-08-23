import { unsafeImageShortcode } from "@cubby/schemas/identifiers";
import type {
  AttachFileResponse,
  CreateFileUploadInput,
  CreateFileUploadResponse,
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
  findUnreferencedImages,
  getImageById,
  getImageByKey,
  UNREFERENCED_IMAGE_GRACE_HOURS,
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
  getS3Object,
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
        return {
          imageId: existing.id,
          key: existing.key,
          url: existing.url,
        };
      }

      const createdImage = await createUploadedImageRecord(db, {
        key,
        filename: params.filenamePrefix,
        size: 0,
        contentType: "application/octet-stream",
        url: params.sourceUrl,
      });
      return {
        imageId: createdImage.id,
        key,
        url: params.sourceUrl,
      };
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

  return {
    imageId: createdImage.id,
    key: stored.key,
    url: stored.url,
  };
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
 * Stage a file for attachment: mint a PENDING image row and presign its PUT.
 *
 * The staged object is scratch space, not the attachment. `attachFileToEntity`
 * reads it back and runs the SAME pipeline every other input mode runs — size
 * and content-type checks, integrity inspection, the transactional insert — and
 * then discards the staging row and its object. Doing it that way rather than
 * promoting the PENDING row in place is the whole point: nothing about the
 * validated path becomes conditional on how the bytes arrived, so a client that
 * PUTs a 400MB file or a mislabelled one fails exactly where a base64 caller
 * would.
 *
 * An abandoned staging row needs no special handling — PENDING with no
 * association is precisely what `findCullablePendingImages` already sweeps.
 */
export const createFileUpload = async (
  db: Database,
  input: CreateFileUploadInput,
): Promise<CreateFileUploadResponse> => {
  const contentType = input.contentType.toLowerCase();
  const isDocument = contentType === PDF_CONTENT_TYPE;
  if (
    !isDocument &&
    !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType)
  ) {
    throw createAppError(
      "IMAGE_UPLOAD_FAILED",
      `Unsupported content type: ${contentType}`,
    );
  }
  if (input.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw createAppError(
      "IMAGE_UPLOAD_FAILED",
      `File exceeds ${MAX_IMAGE_UPLOAD_BYTES} bytes`,
    );
  }

  const key = isDocument
    ? await allocateAttachmentDocumentKey(db, input.filename, input.entityId)
    : generateImageKey(input.filename);
  const { uploadUrl, imageId } = await initiatePendingUpload(
    db,
    { filename: input.filename, contentType, size: input.size },
    key,
  );
  return { uploadId: imageId, uploadUrl };
};

/**
 * Read a staged upload's bytes back out of R2.
 *
 * The PENDING/unassociated check is not a formality. `attachFileToEntity`
 * discards the staging row on success, and `deleteImages` is a HARD delete that
 * takes the row's entity associations with it — so an `uploadId` naming an
 * already-attached image would duplicate the attachment and then destroy the
 * original. That mixup is easy to make rather than exotic: `attach_file`
 * RETURNS an `imageId` and `create_file_upload` returns an `uploadId`, both
 * bare uuids over the same table, so a retry that reaches for the wrong one
 * looks identical. Requiring the staged state turns it into a clean error.
 */
const readStagedUpload = async (
  db: Database,
  uploadId: string,
): Promise<{ bytes: Buffer; contentType: string; filename: string }> => {
  // `getImageById` THROWS `IMAGE_NOT_FOUND` on a miss rather than returning
  // null, so a `if (!staged)` check here would be dead code and the caller
  // would get a bare "Image not found" with no hint about which id it wanted.
  const staged = await getImageById(db, uploadId).catch((error: unknown) => {
    if (
      (error as { cause?: { reason?: string } })?.cause?.reason !==
      "IMAGE_NOT_FOUND"
    ) {
      throw error;
    }
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `Upload ${uploadId} not found. Call create_file_upload first.`,
      error,
    );
  });
  if (staged.status !== "PENDING" || staged.entityType !== null) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${uploadId} is not a staged upload — it is an existing ${staged.entityType ?? "stored"} file. ` +
        "Pass the uploadId returned by create_file_upload, not an imageId from a previous attach_file.",
    );
  }
  const response = await getS3Object(staged.key);
  if (!response.ok) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `Upload ${uploadId} has no stored object — the presigned PUT did not complete.`,
    );
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    // The declared type, not the response's: R2 echoes whatever the PUT set,
    // and the downstream allowlist + `inspectImageFile` are what actually decide
    // whether the bytes are what they claim to be.
    contentType: staged.contentType,
    filename: staged.filename,
  };
};

/**
 * Store a file in R2 and associate it with a product / recipe / location /
 * project / purchase. Three input modes — base64 bytes, a URL the server
 * fetches, or a `uploadId` from {@link createFileUpload} that the client already
 * PUT to R2 — converge on one pipeline after the bytes are in hand, so the
 * allowlist, size limits, integrity inspection, and idempotency apply to all
 * three identically. Unlike {@link importImageFromUrl} (image-only), this also
 * accepts PDFs, so it drives the bytes path directly rather than reusing that
 * helper.
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
        imageId: unsafeImageShortcode(existing.shortcode),
        url: existing.url,
        filename: existing.filename,
        contentType: existing.contentType,
        kind: existing.contentType === PDF_CONTENT_TYPE ? "document" : "image",
        entityType: input.entityType,
        entityId: input.entityId,
        idempotencyKey: existing.idempotencyKey,
        reused: true,
      };
    }
  }

  // 1. Resolve bytes + content type + filename from whichever input mode.
  let bytes: Buffer;
  let contentType: string | undefined;
  let sourceFilename: string | undefined;

  if (input.uploadId) {
    ({
      bytes,
      contentType,
      filename: sourceFilename,
    } = await readStagedUpload(db, input.uploadId));
  } else if (input.data) {
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
      const responseContentTypeHeader = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim();
      const responseContentType =
        responseContentTypeHeader?.toLowerCase() === "application/octet-stream"
          ? undefined
          : responseContentTypeHeader;
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
      contentType = responseContentType ?? input.contentType;
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
    // Unreachable: mcpAttachFileInput.refine enforces exactly one source.
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "Provide exactly one of `url`, `data`, or `uploadId`",
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

  // The staging row and its object have served their purpose — the attachment
  // owns its own copy. Best-effort: `findCullablePendingImages` sweeps an
  // unassociated PENDING row anyway, so a failure here strands bytes for a day
  // rather than leaking them, and must not fail an attachment that succeeded.
  if (input.uploadId) {
    try {
      const { deletedKeys } = await deleteImages(db, [input.uploadId]);
      await deleteStoredObjects(deletedKeys);
    } catch (cleanupError) {
      console.error("Failed to clean up staged upload:", cleanupError);
    }
  }

  return {
    imageId: unsafeImageShortcode(created.row.shortcode),
    url: created.row.url,
    filename: created.row.filename,
    contentType: created.row.contentType,
    kind: created.row.contentType === PDF_CONTENT_TYPE ? "document" : "image",
    entityType: input.entityType,
    entityId: input.entityId,
    idempotencyKey: created.row.idempotencyKey,
    reused: created.reused,
  };
};

/**
 * Best-effort R2 cleanup for rows already removed from the DB. A failed object
 * delete only strands bytes in the bucket — never fail the mutation over it.
 *
 * Exported for the four entity-update seams that detach images: repos must not
 * reach into `~/server/utils/s3` themselves, so `detachImagesFromEntity` hands
 * its reaped keys up and the router/service drains them here, after the commit.
 */
export const deleteStoredObjects = async (keys: string[]): Promise<void> => {
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
 * Delete UPLOADED files nothing references, plus their R2 objects — the sibling
 * of the pending cull for rows that already made it past the upload.
 *
 * Neither removal path produces these any more — a detach reaps via
 * `detachImagesFromEntity`, an entity delete via `removeEntity` — so this is the
 * backfill for rows that accumulated before, and the recovery route if a future
 * removal path forgets. `findUnreferencedImages` is the detector that finds
 * them.
 */
export const cleanupUnreferencedImageStorage = async (
  db: Database,
  olderThanHours: number = UNREFERENCED_IMAGE_GRACE_HOURS,
) => {
  const found = await findUnreferencedImages(db, olderThanHours);
  if (found.length === 0) return { count: 0, deletedIds: [], deletedKeys: [] };
  // Via `deleteImages`, not a bare row delete: these rows can still be FK'd by
  // the tombstoned join rows an entity delete left behind, and only the
  // IMAGE_HARD_DELETE cascade clears every incoming edge first.
  const result = await deleteImages(
    db,
    found.map((row) => row.id),
  );
  await deleteStoredObjects(result.deletedKeys);
  return { count: result.deletedIds.length, ...result };
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

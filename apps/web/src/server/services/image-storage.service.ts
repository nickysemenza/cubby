import type { ImageId, ImageShortcode } from "@cubby/schemas/identifiers";
import {
  parseEntityId,
  parseEntityRef,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
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
  CULL_PENDING_IMAGES_DEFAULT_HOURS,
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
import {
  createAppError,
  toPublicErrorPayload,
} from "~/server/errors/app-error";
import {
  assertAttachableEntityExists,
  createOrReuseAttachedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
  cullPendingImages,
  deleteImages,
  findAttachmentByIdempotencyKey,
  getImageById,
  getImageByKey,
} from "~/server/repo/image";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  filenameForContentType,
  inspectImageFile,
} from "~/server/services/image-integrity";
import {
  extractKeyFromUrl,
  getR2PublicUrl,
  isOurBucketUrl,
} from "~/server/utils/r2-public-url";
import {
  contentTypeToExtension,
  deleteS3Object,
  fetchAndStoreImage,
  generateDocumentKey,
  generateImageKey,
  generatePresignedUploadUrl,
  getS3Object,
  uploadToS3,
} from "~/server/utils/s3";

type WithoutDatabase<TFunction> = TFunction extends (
  database: Database,
  ...args: infer Args
) => infer _Result
  ? Args
  : never;

type AttachedImageRecord = {
  shortcode: string;
  key: string;
  filename: string;
  contentType: string;
  idempotencyKey: string | null;
};

type StagedImageRecord = Pick<
  AttachedImageRecord,
  "key" | "filename" | "contentType"
> & {
  status: string;
  entityType: string | null;
};

/** Explicit external seams for image storage; production binds real adapters. */
export interface ImageStoragePorts<TDatabase> {
  repository: {
    assertAttachableEntityExists: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof assertAttachableEntityExists>
    ) => Promise<void>;
    createOrReuseAttachedImage: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof createOrReuseAttachedImage>
    ) => Promise<{ row: AttachedImageRecord; reused: boolean }>;
    createPendingImageRecord: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof createPendingImageRecord>
    ) => Promise<{ id: string; shortcode: string }>;
    createUploadedImageRecord: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof createUploadedImageRecord>
    ) => Promise<{ shortcode: string }>;
    cullPendingImages: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof cullPendingImages>
    ) => Promise<Awaited<ReturnType<typeof cullPendingImages>>>;
    deleteImages: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof deleteImages>
    ) => Promise<{ deletedIds: string[]; deletedKeys: string[] }>;
    findAttachmentByIdempotencyKey: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof findAttachmentByIdempotencyKey>
    ) => Promise<AttachedImageRecord | null>;
    getImageById: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof getImageById>
    ) => Promise<StagedImageRecord>;
    getImageByKey: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof getImageByKey>
    ) => Promise<{ shortcode: string; key: string; url: string } | null>;
  };
  objectStorage: {
    contentTypeToExtension: typeof contentTypeToExtension;
    deleteObject: typeof deleteS3Object;
    extractKeyFromUrl: typeof extractKeyFromUrl;
    fetchAndStoreImage: typeof fetchAndStoreImage;
    generateDocumentKey: typeof generateDocumentKey;
    generateImageKey: typeof generateImageKey;
    generatePresignedUploadUrl: typeof generatePresignedUploadUrl;
    getObject: typeof getS3Object;
    getPublicUrl: typeof getR2PublicUrl;
    isOurBucketUrl: typeof isOurBucketUrl;
    upload: typeof uploadToS3;
  };
  externalFetch: {
    fetchResponse: typeof fetchExternalResponse;
    readResponseWithLimit: typeof readResponseWithLimit;
    sanitizeUrl: typeof sanitizeExternalUrl;
    validateUrl: typeof validateExternalHttpUrl;
  };
  shortcode: {
    resolveLive: (
      database: TDatabase,
      ...args: WithoutDatabase<typeof resolveLiveShortcode>
    ) => Promise<string | null>;
  };
}

export const productionImageStoragePorts = {
  repository: {
    assertAttachableEntityExists,
    createOrReuseAttachedImage,
    createPendingImageRecord,
    createUploadedImageRecord,
    cullPendingImages,
    deleteImages,
    findAttachmentByIdempotencyKey,
    getImageById,
    getImageByKey,
  },
  objectStorage: {
    contentTypeToExtension,
    deleteObject: deleteS3Object,
    extractKeyFromUrl,
    fetchAndStoreImage,
    generateDocumentKey,
    generateImageKey,
    generatePresignedUploadUrl,
    getObject: getS3Object,
    getPublicUrl: getR2PublicUrl,
    isOurBucketUrl,
    upload: uploadToS3,
  },
  externalFetch: {
    fetchResponse: fetchExternalResponse,
    readResponseWithLimit,
    sanitizeUrl: sanitizeExternalUrl,
    validateUrl: validateExternalHttpUrl,
  },
  shortcode: {
    resolveLive: (database, code, entity) =>
      resolveLiveShortcode(database, code, entity),
  },
} satisfies ImageStoragePorts<Database>;

const initiatePendingUpload = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  input: {
    filename: string;
    contentType: string;
    size: number;
    perceptualHash?: string;
    sourceFingerprint?: { hash: string; aspectRatio: number };
    width?: number;
    height?: number;
  },
  key: string,
) => {
  // Clean-on-write: the only way a PENDING row outlives its upload is a flow
  // abandoned after this presign step, so the next presign is the natural
  // moment to reap the day-old ones — no sweeper, no schedule. Best-effort:
  // a failed cull must not block the upload it precedes.
  try {
    await cullPendingImageStorageWithPorts(
      ports,
      db,
      CULL_PENDING_IMAGES_DEFAULT_HOURS,
    );
  } catch (error) {
    console.error("image.cull-on-presign.failed", error);
  }
  const url = ports.objectStorage.getPublicUrl(key);
  const createdImage = await ports.repository.createPendingImageRecord(db, {
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    key,
    perceptualHash: input.perceptualHash,
    sourceFingerprint: input.sourceFingerprint,
    width: input.width,
    height: input.height,
  });
  const uploadUrl = await ports.objectStorage.generatePresignedUploadUrl({
    key,
    contentType: input.contentType,
  });

  return {
    uploadUrl,
    imageId: parseShortcodeFor("image", createdImage.shortcode),
    key,
    url,
  };
};

// Allocate readable document keys consistently for every upload path. When a
// folder is supplied, it is the owning entity's public shortcode. The image
// table is authoritative for collisions and includes soft-deleted rows, whose
// R2 objects may still exist.
const allocateDocumentKey = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  filename: string,
  folder?: string,
): Promise<string> => {
  let key = ports.objectStorage.generateDocumentKey(filename, folder);
  if (await ports.repository.getImageByKey(db, key)) {
    const dot = filename.lastIndexOf(".");
    const deduped =
      dot > 0
        ? `${filename.slice(0, dot)}-${Date.now()}${filename.slice(dot)}`
        : `${filename}-${Date.now()}`;
    key = ports.objectStorage.generateDocumentKey(deduped, folder);
  }
  return key;
};

// Server-side MCP attempts may race and a losing attempt is required to delete
// only its own object. Unlike browser document uploads, readable keys are not
// worth sharing here: append a UUID before allocation to make that guarantee.
const allocateAttachmentDocumentKey = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  filename: string,
  folder: string,
): Promise<string> => {
  const dot = filename.lastIndexOf(".");
  const attemptFilename =
    dot > 0
      ? `${filename.slice(0, dot)}-${crypto.randomUUID()}${filename.slice(dot)}`
      : `${filename}-${crypto.randomUUID()}`;
  return await allocateDocumentKey(ports, db, attemptFilename, folder);
};

const initiateImageUploadWithoutEntityWithPorts = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  input: InitiateUploadWithoutEntityInput,
) => {
  return initiatePendingUpload(
    ports,
    db,
    input,
    ports.objectStorage.generateImageKey(input.filename),
  );
};

const initiateDocumentUploadWithPorts = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  input: InitiateDocumentUploadInput,
) => {
  const key = await allocateDocumentKey(
    ports,
    db,
    input.filename,
    input.folder,
  );
  return initiatePendingUpload(ports, db, input, key);
};

const importImageFromUrlWithPorts = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  params: { sourceUrl: string; filenamePrefix: string },
): Promise<{ imageId: ImageShortcode; key: string; url: string } | null> => {
  if (ports.objectStorage.isOurBucketUrl(params.sourceUrl)) {
    const key = ports.objectStorage.extractKeyFromUrl(params.sourceUrl);
    if (key) {
      const existing = await ports.repository.getImageByKey(db, key);
      if (existing) {
        return {
          imageId: parseShortcodeFor("image", existing.shortcode),
          key: existing.key,
          url: existing.url,
        };
      }

      const createdImage = await ports.repository.createUploadedImageRecord(
        db,
        {
          key,
          filename: params.filenamePrefix,
          size: 0,
          contentType: "application/octet-stream",
        },
      );
      return {
        imageId: parseShortcodeFor("image", createdImage.shortcode),
        key,
        url: ports.objectStorage.getPublicUrl(key),
      };
    }
  }

  ports.externalFetch.validateUrl(params.sourceUrl);

  const stored = await ports.objectStorage.fetchAndStoreImage(
    params.sourceUrl,
    params.filenamePrefix,
  );
  if (!stored) {
    return null;
  }

  let createdImage: { shortcode: string };
  try {
    createdImage = await ports.repository.createUploadedImageRecord(db, {
      key: stored.key,
      filename: `${params.filenamePrefix}.${ports.objectStorage.contentTypeToExtension(stored.contentType)}`,
      size: stored.size,
      contentType: stored.contentType,
    });
  } catch (error) {
    await ports.objectStorage.deleteObject(stored.key).catch((cleanupError) => {
      console.error("Failed to roll back imported image object:", cleanupError);
    });
    throw error;
  }

  return {
    imageId: parseShortcodeFor("image", createdImage.shortcode),
    key: stored.key,
    url: stored.url,
  };
};

// `data:<type>;base64,<payload>` — capture the (optional) inline type, the
// base64 marker, and the payload. Only base64 data: URIs are supported.
const DATA_URI_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

interface DecodedBase64File {
  bytes: Buffer;
  contentType: string | undefined;
}

function decodeBase64File(
  data: string,
  fallbackContentType: string | undefined,
): DecodedBase64File {
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
const createFileUploadWithPorts = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  input: CreateFileUploadInput,
): Promise<CreateFileUploadResponse> => {
  const contentType = input.contentType.toLowerCase();
  const isDocument = contentType === PDF_CONTENT_TYPE;
  if (
    !isDocument &&
    !ALLOWED_IMAGE_TYPES.some((allowedType) => allowedType === contentType)
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
    ? await allocateAttachmentDocumentKey(
        ports,
        db,
        input.filename,
        input.entityId,
      )
    : ports.objectStorage.generateImageKey(input.filename);
  const { uploadUrl, imageId } = await initiatePendingUpload(
    ports,
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
 * original. That mixup is easy to make rather than exotic: `attach_files`
 * RETURNS an `imageId` and `create_file_uploads` returns an `uploadId`, both
 * `IMG-` codes over the same table, so a retry that reaches for the wrong one
 * looks identical. Requiring the staged state turns it into a clean error.
 *
 * Returns the resolved uuid so the caller's cleanup can hard-delete the staging
 * row without resolving the code a second time.
 */
const readStagedUpload = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  uploadId: string,
): Promise<{
  bytes: Buffer;
  contentType: string;
  filename: string;
  stagedImageId: ImageId;
  stagedKey: string;
}> => {
  const notFound = (cause?: unknown) =>
    createAppError(
      "IMAGE_ATTACH_FAILED",
      `Upload ${uploadId} not found. Call create_file_uploads first.`,
      cause,
    );
  // `uploadId` is the staged row's public `IMG-` code; `getImageById` is a raw
  // uuid PK lookup, so the boundary has to be crossed here.
  const stagedImageId = await ports.shortcode.resolveLive(
    db,
    uploadId,
    "image",
  );
  if (!stagedImageId) throw notFound();
  const stagedImageUuid = parseEntityId("image", stagedImageId);
  // Still reachable after a successful resolve: `deleteImages` is a HARD
  // delete, so a concurrent attach of the same uploadId can take the row out
  // between the two reads.
  const staged = await ports.repository
    .getImageById(db, stagedImageUuid)
    .catch((error) => {
      if (toPublicErrorPayload(error).reason !== "IMAGE_NOT_FOUND") {
        throw error;
      }
      throw notFound(error);
    });
  if (staged.status !== "PENDING" || staged.entityType !== null) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${uploadId} is not a staged upload — it is an existing ${staged.entityType ?? "stored"} file. ` +
        "Pass the uploadId returned by create_file_uploads, not an imageId from a previous attach_files.",
    );
  }
  const response = await ports.objectStorage.getObject(staged.key);
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
    stagedImageId: stagedImageUuid,
    stagedKey: staged.key,
  };
};

type AttachmentSource = {
  bytes: Buffer;
  contentType: string | undefined;
  sourceFilename?: string;
  stagedImageId?: ImageId;
  stagedKey?: string;
};

const readUrlAttachmentSource = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  input: McpAttachFileInput,
): Promise<AttachmentSource> => {
  try {
    const url = ports.externalFetch.validateUrl(input.url ?? "");
    const response = await ports.externalFetch.fetchResponse(url);
    if (!response.ok) {
      throw createAppError(
        "IMAGE_ATTACH_FAILED",
        `Failed to fetch ${ports.externalFetch.sanitizeUrl(url)}: ${response.status}`,
      );
    }
    const bytes = Buffer.from(
      await ports.externalFetch.readResponseWithLimit(
        response,
        MAX_IMAGE_UPLOAD_BYTES,
      ),
    );
    const header = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim();
    const responseContentType =
      header?.toLowerCase() === "application/octet-stream" ? undefined : header;
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
    return {
      bytes,
      contentType: responseContentType ?? input.contentType,
      sourceFilename: new URL(url).pathname.split("/").pop() || undefined,
    };
  } catch (error) {
    if (error instanceof ExternalFetchError) {
      throw createAppError("IMAGE_ATTACH_FAILED", error.message, error);
    }
    throw error;
  }
};

const readAttachmentSource = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  input: McpAttachFileInput,
): Promise<AttachmentSource> => {
  if (input.uploadId) {
    const staged = await readStagedUpload(ports, db, input.uploadId);
    return { ...staged, sourceFilename: staged.filename };
  }
  if (input.data) {
    const decoded = decodeBase64File(input.data, input.contentType);
    return { ...decoded };
  }
  if (input.url) return readUrlAttachmentSource(ports, input);
  throw createAppError(
    "IMAGE_ATTACH_FAILED",
    "Provide exactly one of `url`, `data`, or `uploadId`",
  );
};

const validateAttachmentSource = async (source: AttachmentSource) => {
  if (!source.contentType) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "contentType is required for base64 data (or use a data: URI)",
    );
  }
  const contentType = source.contentType.toLowerCase();
  const isDocument = contentType === PDF_CONTENT_TYPE;
  if (
    !isDocument &&
    !ALLOWED_IMAGE_TYPES.some((allowedType) => allowedType === contentType)
  ) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `Unsupported content type: ${contentType}`,
    );
  }
  if (source.bytes.length === 0) {
    throw createAppError("IMAGE_ATTACH_FAILED", "File is empty");
  }
  if (source.bytes.length > MAX_IMAGE_UPLOAD_BYTES) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `File exceeds ${MAX_IMAGE_UPLOAD_BYTES} bytes`,
    );
  }
  return {
    contentType,
    isDocument,
    inspected: await inspectImageFile(source.bytes, contentType),
  };
};

const attachmentResponse = <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  row: AttachedImageRecord,
  input: McpAttachFileInput,
  reused: boolean,
  cleanupWarning?: string,
): AttachFileResponse => {
  const response: AttachFileResponse = {
    imageId: parseShortcodeFor("image", row.shortcode),
    url: ports.objectStorage.getPublicUrl(row.key),
    filename: row.filename,
    contentType: row.contentType,
    kind: row.contentType === PDF_CONTENT_TYPE ? "document" : "image",
    entityType: input.entityType,
    entityId: input.entityId,
    idempotencyKey: row.idempotencyKey,
    reused,
  };
  if (cleanupWarning) response.cleanupWarning = cleanupWarning;
  return response;
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
const attachFileToEntityWithPorts = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  input: McpAttachFileInput,
): Promise<AttachFileResponse> => {
  // Fail a bad target id before we touch R2, so we never orphan an object.
  const entityId = await ports.shortcode.resolveLive(
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
  const entity = parseEntityRef(input.entityType, entityId);
  await ports.repository.assertAttachableEntityExists(db, entity);

  // A cheap retry can return before fetching/uploading bytes. The same lookup
  // runs under the target-row lock in the repo to close the upload race.
  if (input.idempotencyKey) {
    const existing = await ports.repository.findAttachmentByIdempotencyKey(
      db,
      entity,
      input.idempotencyKey,
    );
    if (existing) {
      return attachmentResponse(ports, existing, input, true);
    }
  }

  const source = await readAttachmentSource(ports, db, input);
  const { contentType, isDocument, inspected } =
    await validateAttachmentSource(source);

  // Allocate the final key, then register it before writing bytes.
  const extension = isDocument
    ? "pdf"
    : ports.objectStorage.contentTypeToExtension(contentType);
  const filename = filenameForContentType(
    input.filename ?? source.sourceFilename ?? `attachment.${extension}`,
    contentType,
  );
  const key = isDocument
    ? await allocateAttachmentDocumentKey(ports, db, filename, input.entityId)
    : ports.objectStorage.generateImageKey(filename);

  // Register the object before writing it so a process interruption between
  // R2 and association remains discoverable by the existing PENDING sweep.
  const pending = await ports.repository.createPendingImageRecord(db, {
    key,
    filename,
    contentType,
    size: source.bytes.length,
  });
  const pendingImageId = parseEntityId("image", pending.id);
  try {
    await ports.objectStorage.upload({ key, body: source.bytes, contentType });
  } catch (error) {
    try {
      await ports.objectStorage.deleteObject(key);
      await ports.repository.deleteImages(db, [pendingImageId]);
    } catch (cleanupError) {
      throw createAppError(
        "IMAGE_ATTACH_FAILED",
        "File upload failed and its partial object could not be cleaned up",
        { uploadError: error, cleanupError },
      );
    }
    throw error;
  }
  // Promote the pending row + associate it in one repository transaction. A
  // failure removes the object before its pending cleanup record.
  let created: { row: AttachedImageRecord; reused: boolean };
  try {
    created = await ports.repository.createOrReuseAttachedImage(
      db,
      {
        key,
        filename,
        size: source.bytes.length,
        ...inspected,
        pendingImageId,
        idempotencyKey: input.idempotencyKey,
        expectedImageCount: input.expectedImageCount,
      },
      entity,
      input.documentKind,
    );
  } catch (error) {
    try {
      await ports.objectStorage.deleteObject(key);
      await ports.repository.deleteImages(db, [pendingImageId]);
    } catch (cleanupError) {
      throw createAppError(
        "IMAGE_ATTACH_FAILED",
        "File attachment failed and its uploaded object could not be cleaned up",
        { attachmentError: error, cleanupError },
      );
    }
    throw error;
  }

  let cleanupWarning: string | undefined;
  if (created.reused) {
    try {
      await ports.objectStorage.deleteObject(key);
      await ports.repository.deleteImages(db, [pendingImageId]);
    } catch {
      cleanupWarning =
        "The attachment was reused, but its redundant upload could not be cleaned up.";
    }
  }

  // The staging row and its object have served their purpose — the attachment
  // owns its own copy. Best-effort: `findCullablePendingImages` sweeps an
  // unassociated PENDING row anyway, so a failure here strands bytes for a day
  // rather than leaking them, and must not fail an attachment that succeeded.
  if (source.stagedImageId) {
    try {
      if (!source.stagedKey) {
        throw new Error("Staged attachment source is missing its storage key");
      }
      await ports.objectStorage.deleteObject(source.stagedKey);
      // The uuid `readStagedUpload` already resolved from the `IMG-` code —
      // `deleteImages` writes against the uuid PK, and a shortcode here would
      // silently delete nothing and strand the staged object.
      await ports.repository.deleteImages(db, [source.stagedImageId]);
    } catch (cleanupError) {
      console.error("Failed to clean up staged upload:", cleanupError);
      cleanupWarning =
        "The attachment succeeded, but its staged upload could not be cleaned up.";
    }
  }

  return attachmentResponse(
    ports,
    created.row,
    input,
    created.reused,
    cleanupWarning,
  );
};

/**
 * Best-effort R2 cleanup for rows already removed from the DB. A failed object
 * delete only strands bytes in the bucket — never fail the mutation over it.
 *
 * Exported for the four entity-update seams that detach images: repos must not
 * reach into `~/server/utils/s3` themselves, so `detachImagesFromEntity` hands
 * its reaped keys up and the router/service drains them here, after the commit.
 */
const deleteStoredObjectsWithPorts = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  keys: string[],
): Promise<void> => {
  for (const key of keys) {
    try {
      await ports.objectStorage.deleteObject(key);
    } catch (error) {
      console.error("Error deleting image from R2:", error);
    }
  }
};

const cullPendingImageStorageWithPorts = async <TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
  db: TDatabase,
  olderThanHours: number,
) => {
  const result = await ports.repository.cullPendingImages(db, olderThanHours);
  await deleteStoredObjectsWithPorts(ports, result.deletedKeys);
  return result;
};

/** Bind image storage to real infrastructure or a local in-memory test port. */
export function createImageStorageService<TDatabase>(
  ports: ImageStoragePorts<TDatabase>,
) {
  return {
    attachFileToEntity: (database: TDatabase, input: McpAttachFileInput) =>
      attachFileToEntityWithPorts(ports, database, input),
    cullPendingImageStorage: (database: TDatabase, olderThanHours: number) =>
      cullPendingImageStorageWithPorts(ports, database, olderThanHours),
    createFileUpload: (database: TDatabase, input: CreateFileUploadInput) =>
      createFileUploadWithPorts(ports, database, input),
    deleteStoredObjects: (keys: string[]) =>
      deleteStoredObjectsWithPorts(ports, keys),
    importImageFromUrl: (
      database: TDatabase,
      params: { sourceUrl: string; filenamePrefix: string },
    ) => importImageFromUrlWithPorts(ports, database, params),
    initiateDocumentUpload: (
      database: TDatabase,
      input: InitiateDocumentUploadInput,
    ) => initiateDocumentUploadWithPorts(ports, database, input),
    initiateImageUploadWithoutEntity: (
      database: TDatabase,
      input: InitiateUploadWithoutEntityInput,
    ) => initiateImageUploadWithoutEntityWithPorts(ports, database, input),
  };
}

const productionImageStorage = createImageStorageService(
  productionImageStoragePorts,
);

export const attachFileToEntity = productionImageStorage.attachFileToEntity;
export const cullPendingImageStorage =
  productionImageStorage.cullPendingImageStorage;
export const createFileUpload = productionImageStorage.createFileUpload;
export const deleteStoredObjects = productionImageStorage.deleteStoredObjects;
export const importImageFromUrl = productionImageStorage.importImageFromUrl;
export const initiateDocumentUpload =
  productionImageStorage.initiateDocumentUpload;
export const initiateImageUploadWithoutEntity =
  productionImageStorage.initiateImageUploadWithoutEntity;

import { ALLOWED_IMAGE_TYPES } from "@cubby/schemas/image";
import {
  assertResponseContentType,
  ExternalFetchError,
  fetchExternalResponse,
  MAX_EXTERNAL_IMAGE_BYTES,
  readResponseWithLimit,
  sanitizeExternalUrl,
} from "@cubby/shared/external-fetch";
import { TRPCError } from "@trpc/server";
import { AwsClient } from "aws4fetch";
import { env } from "~/env";
import { createAppError } from "~/server/errors/app-error";

// SigV4 fetch signer for Cloudflare R2 (S3 API). aws4fetch is Workers-native and
// runs identically in Node (vite dev) and Workers — no dev/prod split. R2 requires
// region "auto" + service "s3" set explicitly (CF's docs rely on host autodetection,
// but explicit avoids signature/region mismatches).
const r2 = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});

// S3-API object URL (for signing/PUT/DELETE), distinct from the public delivery
// URL produced by getS3ObjectUrl.
const objectUrl = (key: string) =>
  `${env.R2_ENDPOINT}/${env.R2_BUCKET_NAME}/${key}`;

interface PresignedUrlParams {
  key: string;
  contentType: string;
  expiresIn?: number; // in seconds
}

/**
 * Generate a presigned URL for uploading a file to S3.
 *
 * Content-Type is a signed header. The browser must echo the validated type from
 * the initiation request, so the public bucket cannot be used to host arbitrary
 * active content under a misleading extension.
 */
export const generatePresignedUploadUrl = async ({
  key,
  contentType,
  expiresIn = 300, // Default 5 minutes
}: PresignedUrlParams): Promise<string> => {
  const u = new URL(objectUrl(key));
  u.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await r2.sign(
    new Request(u, {
      method: "PUT",
      headers: { "content-type": contentType },
    }),
    {
      aws: { signQuery: true },
    },
  );
  return signed.url;
};

/**
 * Map common content types to file extensions
 */
export const contentTypeToExtension = (contentType: string): string => {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[contentType] || "jpg";
};

/**
 * Generate a key for an image file
 */
export const generateImageKey = (filename: string): string => {
  const timestamp = Date.now();
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  const extension = sanitizedFilename.split(".").pop() || "";
  const baseName = sanitizedFilename.replace(`.${extension}`, "");

  const prefix = env.R2_KEY_PREFIX;
  return `${prefix}/images/${baseName}-${timestamp}.${extension}`;
};

/**
 * Generate a key for a document (PDF manual). Unlike images, the original
 * filename is preserved (no timestamp) so the public URL stays readable, and
 * an optional folder (the owning entity's shortcode) namespaces the object:
 * `{prefix}/documents/P-0123/blender-manual.pdf`. Collisions are handled by
 * the caller (initiateDocumentUpload) via a DB key lookup.
 */
export const generateDocumentKey = (
  filename: string,
  folder?: string,
): string => {
  // Sanitization doubles as path-traversal defense: "/" and "." sequences in
  // the folder can't escape the documents/ prefix.
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const sanitizedFolder = folder?.replace(/[^a-zA-Z0-9_-]/g, "_");
  const prefix = env.R2_KEY_PREFIX;
  const folderSegment = sanitizedFolder ? `${sanitizedFolder}/` : "";
  return `${prefix}/documents/${folderSegment}${sanitizedFilename}`;
};

/**
 * Generate an R2 object URL
 */
export const getS3ObjectUrl = (key: string): string => {
  // For Cloudflare R2, the URL format is the public URL to your bucket
  return `${env.R2_PUBLIC_URL}/${key}`;
};

/**
 * Check if a URL is from our R2 bucket
 */
export const isOurBucketUrl = (url: string): boolean => {
  return url.startsWith(env.R2_PUBLIC_URL);
};

/**
 * Extract the S3 key from one of our bucket URLs
 * Returns null if URL is not from our bucket
 */
export const extractKeyFromUrl = (url: string): string | null => {
  const prefix = `${env.R2_PUBLIC_URL}/`;
  if (!url.startsWith(prefix)) return null;
  return url.slice(prefix.length);
};

/**
 * Delete an object from S3/R2 storage
 * @param key The key of the object to delete
 */
export const deleteS3Object = async (key: string): Promise<void> => {
  const res = await r2.fetch(objectUrl(key), { method: "DELETE" });
  // R2 returns 204 on delete; treat a missing object (404) as success too.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete ${key}: ${res.status} ${res.statusText}`);
  }
};

/**
 * Upload a file directly to S3/R2 storage (server-side upload)
 * Use this for importing images from external URLs where presigned URLs aren't needed.
 */
const uploadToS3 = async (params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> => {
  // Server-side PUT signs the request itself, so Content-Type AND Cache-Control
  // are applied to the stored object (unlike the presigned-upload path).
  const res = await r2.fetch(objectUrl(params.key), {
    method: "PUT",
    // Buffer is typed Buffer<ArrayBufferLike> which isn't a valid BodyInit
    // (the backing may be SharedArrayBuffer); a plain Uint8Array view fixes it.
    body: new Uint8Array(params.body),
    headers: {
      "content-type": params.contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to upload ${params.key}: ${res.status} ${res.statusText}`,
    );
  }
};

// --- Image import utilities (merged from image-import.ts) ---

interface FetchAndStoreResult {
  key: string;
  url: string;
  contentType: string;
  size: number;
}

/**
 * Fetch an image from an external URL and store it in our R2 bucket.
 *
 * @param sourceUrl - The external URL to fetch the image from
 * @param filenamePrefix - Prefix for the generated filename (e.g., "upc-123456789012")
 * @returns Object with key, url, contentType, and size, or null on failure
 */
export const fetchAndStoreImage = async (
  sourceUrl: string,
  filenamePrefix: string,
): Promise<FetchAndStoreResult | null> => {
  try {
    const response = await fetchExternalResponse(sourceUrl);

    if (!response.ok) {
      console.error(
        `[fetchAndStoreImage] Failed to fetch image from ${sanitizeExternalUrl(sourceUrl)}: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    // Get content type and validate it's an image
    const contentType = assertResponseContentType(
      response,
      ALLOWED_IMAGE_TYPES,
    );

    // Read the image data, enforcing the byte cap during the stream.
    const buffer = Buffer.from(
      await readResponseWithLimit(response, MAX_EXTERNAL_IMAGE_BYTES),
    );
    const size = buffer.length;

    if (size === 0) {
      console.error(
        `[fetchAndStoreImage] Empty image from ${sanitizeExternalUrl(sourceUrl)}`,
      );
      return null;
    }

    // Generate key and upload to R2
    const extension = contentTypeToExtension(contentType);
    const filename = `${filenamePrefix}.${extension}`;
    const key = generateImageKey(filename);

    await uploadToS3({
      key,
      body: buffer,
      contentType,
    });

    const url = getS3ObjectUrl(key);

    return {
      key,
      url,
      contentType,
      size,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      console.error(
        `[fetchAndStoreImage] Timeout fetching image from ${sanitizeExternalUrl(sourceUrl)}`,
      );
      return null;
    }
    // The size-cap rejection is a typed AppError (TRPCError). Re-throw it so the
    // oversized-payload case surfaces as a real error rather than being masked as
    // a generic null import failure — createAppError already logged + annotated.
    if (error instanceof TRPCError) {
      throw error;
    }
    if (error instanceof ExternalFetchError) {
      throw createAppError("IMAGE_IMPORT_FAILED", error.message, error);
    }
    console.error(`[fetchAndStoreImage] Error importing image:`, error);
    return null;
  }
};

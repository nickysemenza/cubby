import {
  MAX_EXTERNAL_IMAGE_BYTES,
  assertResponseContentType,
  fetchExternalResponse,
  responseBodyWithLimit,
  sanitizeExternalUrl,
} from "@cubby/shared/external-fetch";
import type { Env } from "../types";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

const IMAGE_EXTENSIONS = ["jpg", "png", "gif", "webp", "heic", "heif"] as const;

function imageVariantKeys(upc: string): string[] {
  return IMAGE_EXTENSIONS.map((extension) => `images/${upc}.${extension}`);
}

/**
 * Download an image from an external URL and store it in R2.
 * Returns the R2 object key if successful, null otherwise.
 * Non-blocking - failures don't throw, just return null.
 */
export async function storeImage(
  upc: string,
  imageUrl: string,
  env: Env,
): Promise<string | null> {
  try {
    const response = await fetchExternalResponse(imageUrl);

    if (!response.ok) {
      console.error(
        `Failed to fetch image ${sanitizeExternalUrl(imageUrl)}: ${response.status}`,
      );
      return null;
    }

    const contentType = assertResponseContentType(
      response,
      ALLOWED_IMAGE_TYPES,
    );
    const ext = getExtensionFromContentType(contentType);
    const key = `images/${upc}.${ext}`;

    await env.IMAGES.put(
      key,
      responseBodyWithLimit(response, MAX_EXTERNAL_IMAGE_BYTES),
      {
        httpMetadata: { contentType },
      },
    );

    return key;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      console.error("Image fetch timeout");
    } else {
      console.error("Image storage error:", error);
    }
    return null;
  }
}

/**
 * Store an already-in-hand image file (e.g. a drag/drop/paste upload from the
 * admin form) in R2. Returns the R2 object key, or null on failure.
 */
export async function storeImageBlob(
  upc: string,
  file: File,
  env: Env,
): Promise<string | null> {
  try {
    if (file.size > MAX_EXTERNAL_IMAGE_BYTES) {
      throw new Error(`Image exceeds ${MAX_EXTERNAL_IMAGE_BYTES} bytes`);
    }
    if (
      !ALLOWED_IMAGE_TYPES.includes(
        file.type as (typeof ALLOWED_IMAGE_TYPES)[number],
      )
    ) {
      throw new Error(
        `Unsupported image content type: ${file.type || "missing"}`,
      );
    }
    const contentType = file.type;
    const ext = getExtensionFromContentType(contentType);
    const key = `images/${upc}.${ext}`;
    await env.IMAGES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType },
    });
    return key;
  } catch (error) {
    console.error("Image blob storage error:", error);
    return null;
  }
}

/** Remove every known MIME variant except the object referenced by D1. */
export async function cleanupImageVariants(
  env: Env,
  upc: string,
  currentImageKey: string | null,
): Promise<void> {
  const staleKeys = imageVariantKeys(upc).filter(
    (key) => key !== currentImageKey,
  );
  await deleteImages(env, staleKeys);
}

/** Remove every known object variant for a deleted product. */
export async function deleteImageVariants(
  env: Env,
  upc: string,
): Promise<void> {
  await deleteImages(env, imageVariantKeys(upc));
}

async function deleteImages(env: Env, imageKeys: string[]): Promise<void> {
  try {
    await env.IMAGES.delete(imageKeys);
  } catch (error) {
    console.error("Image delete error:", error);
  }
}

/**
 * Get the URL for an image stored in R2.
 * When baseUrl is provided, returns a full URL (for API responses).
 * When baseUrl is omitted, returns a relative path (for HTML rendering).
 */
export function getImageUrl(imageKey: string, baseUrl?: string): string {
  const path = `/${imageKey}`;
  if (baseUrl) {
    return `${baseUrl}${path}`;
  }
  return path;
}

function getExtensionFromContentType(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("heic")) return "heic";
  if (contentType.includes("heif")) return "heif";
  return "jpg";
}

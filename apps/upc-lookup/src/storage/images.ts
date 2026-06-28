import type { Env } from "../types";

const TIMEOUT_MS = 10000;

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
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`Failed to fetch image: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const ext = getExtensionFromContentType(contentType);
    const key = `images/${upc}.${ext}`;

    await env.IMAGES.put(key, response.body, {
      httpMetadata: { contentType },
    });

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
    const contentType = file.type || "image/jpeg";
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

/**
 * Delete an image from R2 by its object key.
 * Non-blocking - failures are logged but don't throw.
 */
export async function deleteImage(env: Env, imageKey: string): Promise<void> {
  try {
    await env.IMAGES.delete(imageKey);
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
  return "jpg";
}

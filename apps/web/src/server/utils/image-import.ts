/**
 * Utility for importing images from external URLs into our R2 storage.
 */

import { generateImageKey, getS3ObjectUrl, uploadToS3 } from "./s3";

const IMAGE_FETCH_TIMEOUT_MS = 10000;

interface FetchAndStoreResult {
  key: string;
  url: string;
  contentType: string;
  size: number;
}

/**
 * Map common content types to file extensions
 */
const contentTypeToExtension = (contentType: string): string => {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[contentType] || "jpg";
};

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
    // Fetch the image with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      IMAGE_FETCH_TIMEOUT_MS,
    );

    const response = await fetch(sourceUrl, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(
        `[fetchAndStoreImage] Failed to fetch image from ${sourceUrl}: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    // Get content type and validate it's an image
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      console.error(
        `[fetchAndStoreImage] Invalid content type: ${contentType}`,
      );
      return null;
    }

    // Read the image data
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const size = buffer.length;

    if (size === 0) {
      console.error(`[fetchAndStoreImage] Empty image from ${sourceUrl}`);
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

    console.log(
      `[fetchAndStoreImage] Successfully stored image: ${sourceUrl} -> ${key} (${size} bytes)`,
    );

    return {
      key,
      url,
      contentType,
      size,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(
        `[fetchAndStoreImage] Timeout fetching image from ${sourceUrl}`,
      );
    } else {
      console.error(`[fetchAndStoreImage] Error importing image:`, error);
    }
    return null;
  }
};

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "~/env";

// Create S3 client for Cloudflare R2
const s3Client = new S3Client({
  region: "auto", // R2 ignores this, but it's required by the SDK
  endpoint: env.R2_ENDPOINT, // Cloudflare R2 endpoint
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const IMAGE_FETCH_TIMEOUT_MS = 10000;

interface PresignedUrlParams {
  key: string;
  contentType: string;
  expiresIn?: number; // in seconds
}

/**
 * Generate a presigned URL for uploading a file to S3
 */
export const generatePresignedUploadUrl = async ({
  key,
  contentType,
  expiresIn = 300, // Default 5 minutes
}: PresignedUrlParams): Promise<string> => {
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const signedUrl = await getSignedUrl(s3Client, command, {
    expiresIn,
  });

  return signedUrl;
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
  const command = new DeleteObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
  });

  await s3Client.send(command);
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
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
  });

  await s3Client.send(command);
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

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
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
 * Generate a key for an image file
 */
export const generateImageKey = (filename: string): string => {
  const timestamp = Date.now();
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  const extension = sanitizedFilename.split(".").pop() || "";
  const baseName = sanitizedFilename.replace(`.${extension}`, "");

  // Store all images in the recipehub-dev folder
  return `recipehub-dev/images/${baseName}-${timestamp}.${extension}`;
};

/**
 * Generate an R2 object URL
 */
export const getS3ObjectUrl = (key: string): string => {
  // For Cloudflare R2, the URL format is the public URL to your bucket
  // Replace the domain with your actual Cloudflare R2 public URL
  return `${env.R2_PUBLIC_URL}/${key}`;
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

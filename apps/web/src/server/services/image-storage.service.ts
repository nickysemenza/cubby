import type { InitiateUploadWithoutEntityInput } from "@cubby/schemas/image";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  createPendingImageRecord,
  createUploadedImageRecord,
  cullPendingImages,
  getImageByKey,
} from "~/server/repo/image";
import {
  contentTypeToExtension,
  deleteS3Object,
  extractKeyFromUrl,
  fetchAndStoreImage,
  generateImageKey,
  generatePresignedUploadUrl,
  getS3ObjectUrl,
  isOurBucketUrl,
} from "~/server/utils/s3";

const privateIpv4Ranges = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

function assertSafeExternalImageUrl(sourceUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch (error) {
    throw createAppError("IMAGE_IMPORT_FAILED", "Invalid image URL", error);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw createAppError(
      "IMAGE_IMPORT_FAILED",
      "Image imports only support HTTP(S) URLs",
    );
  }

  if (parsed.username || parsed.password) {
    throw createAppError(
      "IMAGE_IMPORT_FAILED",
      "Image import URLs cannot include credentials",
    );
  }

  const host = parsed.hostname.toLowerCase();
  const ipv6Host = host.replace(/^\[/, "").replace(/\]$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    ipv6Host === "::1" ||
    (ipv6Host.includes(":") &&
      (ipv6Host.startsWith("fc") ||
        ipv6Host.startsWith("fd") ||
        ipv6Host.startsWith("fe80"))) ||
    privateIpv4Ranges.some((range) => range.test(host))
  ) {
    throw createAppError(
      "IMAGE_IMPORT_FAILED",
      "Image import URL points to a private host",
    );
  }
}

export const initiateImageUploadWithoutEntity = async (
  db: Database,
  input: InitiateUploadWithoutEntityInput,
) => {
  const key = generateImageKey(input.filename);
  const url = getS3ObjectUrl(key);
  const createdImage = await createPendingImageRecord(db, {
    ...input,
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

  assertSafeExternalImageUrl(params.sourceUrl);

  const stored = await fetchAndStoreImage(
    params.sourceUrl,
    params.filenamePrefix,
  );
  if (!stored) {
    return null;
  }

  const createdImage = await createUploadedImageRecord(db, {
    key: stored.key,
    filename: `${params.filenamePrefix}.${contentTypeToExtension(stored.contentType)}`,
    size: stored.size,
    contentType: stored.contentType,
    url: stored.url,
  });

  return { imageId: createdImage.id, key: stored.key, url: stored.url };
};

export const cullPendingImageStorage = async (
  db: Database,
  olderThanHours: number,
) => {
  const result = await cullPendingImages(db, olderThanHours);

  for (const key of result.deletedKeys) {
    try {
      await deleteS3Object(key);
    } catch (error) {
      console.error("Error deleting image from R2:", error);
    }
  }

  return result;
};

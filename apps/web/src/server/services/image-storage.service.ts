import type {
  InitiateDocumentUploadInput,
  InitiateUploadWithoutEntityInput,
} from "@cubby/schemas/image";
import { validateExternalHttpUrl } from "@cubby/shared/external-fetch";
import type { Database } from "~/server/db";
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
  generateDocumentKey,
  generateImageKey,
  generatePresignedUploadUrl,
  getS3ObjectUrl,
  isOurBucketUrl,
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

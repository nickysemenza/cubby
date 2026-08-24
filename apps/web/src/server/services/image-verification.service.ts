import type { AttachableImageEntity } from "@cubby/schemas/image";
import type { Database } from "~/server/db";
import {
  getImagesAttachedToEntity,
  updateImageIntegrity,
} from "~/server/repo/image";
import { inspectImageFile } from "~/server/services/image-integrity";
import { getS3Object } from "~/server/utils/s3";

export type ImageVerificationResult = {
  imageId: string;
  storageStatus: "available" | "missing" | "metadata_mismatch";
};

/** Verify stored bytes only when explicitly requested. This backfills legacy
 * rows without making product/detail reads perform R2 network I/O. */
const verifyEntityImages = async (
  db: Database,
  entityType: AttachableImageEntity,
  entityId: string,
): Promise<ImageVerificationResult[]> => {
  const rows = await getImagesAttachedToEntity(db, entityType, entityId);
  const results: ImageVerificationResult[] = [];
  for (const row of rows) {
    const response = await getS3Object(row.key);
    if (response.status === 404) {
      await updateImageIntegrity(db, row.id, {
        renderStatus: "failed",
        storageStatus: "missing",
        verifiedAt: new Date(),
      });
      results.push({ imageId: row.id, storageStatus: "missing" });
      continue;
    }
    if (!response.ok)
      throw new Error(`Failed to read ${row.key}: ${response.status}`);
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const storedContentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      const inspected = await inspectImageFile(bytes, row.contentType);
      const metadataMismatch =
        (storedContentType !== undefined &&
          storedContentType !== row.contentType.toLowerCase()) ||
        bytes.length !== row.size ||
        (row.width !== null && row.width !== inspected.width) ||
        (row.height !== null && row.height !== inspected.height) ||
        (row.detectedContentType !== null &&
          row.detectedContentType !== inspected.detectedContentType) ||
        (row.sha256 !== null && row.sha256 !== inspected.sha256);
      if (metadataMismatch) {
        await updateImageIntegrity(db, row.id, {
          renderStatus: "failed",
          storageStatus: "metadata_mismatch",
          verifiedAt: new Date(),
        });
        results.push({
          imageId: row.id,
          storageStatus: "metadata_mismatch",
        });
        continue;
      }
      await updateImageIntegrity(db, row.id, inspected);
      results.push({ imageId: row.id, storageStatus: "available" });
    } catch (_error) {
      await updateImageIntegrity(db, row.id, {
        renderStatus: "failed",
        storageStatus: "metadata_mismatch",
        verifiedAt: new Date(),
      });
      results.push({ imageId: row.id, storageStatus: "metadata_mismatch" });
    }
  }
  return results;
};

export const verifyProductImages = async (
  db: Database,
  productId: string,
): Promise<ImageVerificationResult[]> =>
  verifyEntityImages(db, "product", productId);

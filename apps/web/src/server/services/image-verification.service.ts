import type { ProductId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import type { AttachableImageRef } from "~/server/repo/image";
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
export type ImageVerificationRow = Pick<
  Awaited<ReturnType<typeof getImagesAttachedToEntity>>[number],
  | "id"
  | "key"
  | "contentType"
  | "size"
  | "width"
  | "height"
  | "detectedContentType"
  | "sha256"
>;

export interface ImageVerificationPorts {
  readonly getImagesAttachedToEntity: (
    db: Database,
    entity: AttachableImageRef,
  ) => Promise<ImageVerificationRow[]>;
  readonly updateImageIntegrity: typeof updateImageIntegrity;
  readonly getObject: typeof getS3Object;
  readonly inspectImageFile: typeof inspectImageFile;
}

const productionImageVerificationPorts: ImageVerificationPorts = {
  getImagesAttachedToEntity,
  updateImageIntegrity,
  getObject: getS3Object,
  inspectImageFile,
};

/** Verify stored bytes only when explicitly requested. This backfills legacy
 * rows without making product/detail reads perform R2 network I/O. */
export const verifyImageRows = async (
  db: Database,
  rows: ImageVerificationRow[],
  ports: Pick<
    ImageVerificationPorts,
    "updateImageIntegrity" | "getObject" | "inspectImageFile"
  > = productionImageVerificationPorts,
): Promise<ImageVerificationResult[]> => {
  const results: ImageVerificationResult[] = [];
  for (const row of rows) {
    const response = await ports.getObject(row.key);
    if (response.status === 404) {
      await ports.updateImageIntegrity(db, row.id, {
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
      const inspected = await ports.inspectImageFile(bytes, row.contentType);
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
        await ports.updateImageIntegrity(db, row.id, {
          renderStatus: "failed",
          storageStatus: "metadata_mismatch",
          verifiedAt: new Date(),
        });
        results.push({ imageId: row.id, storageStatus: "metadata_mismatch" });
        continue;
      }
      await ports.updateImageIntegrity(db, row.id, inspected);
      results.push({ imageId: row.id, storageStatus: "available" });
    } catch (error) {
      // SILENT: an inspection failure (corrupt bytes, unreadable format) is
      // already surfaced to the caller as this row's `metadata_mismatch`
      // result below; there's no richer caller-visible channel at this
      // per-row granularity.
      console.error("image-verification.inspect-failed", { id: row.id, error });
      await ports.updateImageIntegrity(db, row.id, {
        renderStatus: "failed",
        storageStatus: "metadata_mismatch",
        verifiedAt: new Date(),
      });
      results.push({ imageId: row.id, storageStatus: "metadata_mismatch" });
    }
  }
  return results;
};

const verifyEntityImages = async (
  db: Database,
  entity: AttachableImageRef,
  ports: ImageVerificationPorts,
): Promise<ImageVerificationResult[]> => {
  const rows = await ports.getImagesAttachedToEntity(db, entity);
  return verifyImageRows(db, rows, ports);
};

export const verifyProductImages = async (
  db: Database,
  productId: ProductId,
  ports: ImageVerificationPorts = productionImageVerificationPorts,
): Promise<ImageVerificationResult[]> =>
  verifyEntityImages(db, { entity: "product", id: productId }, ports);

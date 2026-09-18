import type {
  PhotoImportReconcileInput,
  PhotoImportReconcileOutput,
} from "~/contracts/photo-import.contract";
import type { Database } from "~/server/db";
import { getImagesByShortcodes } from "~/server/repo/image";
import {
  lockImportImageRows,
  withPhotoImportTransaction,
} from "~/server/repo/photo-import";

export interface PhotoImportReconcilePorts {
  lockImages: typeof lockImportImageRows;
  getImages: typeof getImagesByShortcodes;
  withTransaction: typeof withPhotoImportTransaction;
}

const productionPorts: PhotoImportReconcilePorts = {
  lockImages: lockImportImageRows,
  getImages: getImagesByShortcodes,
  withTransaction: withPhotoImportTransaction,
};

/**
 * Reconcile after an ambiguous original commit response. Taking the same row
 * locks as commit prevents the association snapshot from straddling the
 * database transaction. If it observes all PENDING during commit preflight,
 * an explicit retry is still safe because the commit's locked-status
 * comparison lets only one request consume those rows before any route write.
 */
export async function reconcilePhotoImport(
  db: Database,
  input: PhotoImportReconcileInput,
  ports: PhotoImportReconcilePorts = productionPorts,
): Promise<PhotoImportReconcileOutput> {
  const imageIds = [...new Set(input.imageIds)];
  return ports.withTransaction(db, async (transactionDb) => {
    await ports.lockImages(transactionDb, imageIds);
    const images = await ports.getImages(transactionDb, imageIds);
    const byId = new Map(images.map((entry) => [entry.id, entry] as const));
    return {
      items: imageIds.flatMap((imageId) => {
        const entry = byId.get(imageId);
        return entry
          ? [
              {
                imageId: entry.id,
                status: entry.status,
                associations: entry.associations,
              },
            ]
          : [];
      }),
      missing: imageIds.filter((imageId) => !byId.has(imageId)),
    };
  });
}

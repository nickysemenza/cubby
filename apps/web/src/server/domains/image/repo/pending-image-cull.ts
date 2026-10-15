import { deleteStoredObjects } from "~/server/clients/s3";
import type { Database } from "~/server/db";

import { cullPendingImages } from "./image";

/** Reap abandoned pending uploads, then drain their R2 objects after the delete commits. */
export const cullPendingImageStorage = async (
  db: Database,
  olderThanHours: number,
) => {
  const result = await cullPendingImages(db, olderThanHours);
  await deleteStoredObjects(result.deletedKeys);
  return result;
};

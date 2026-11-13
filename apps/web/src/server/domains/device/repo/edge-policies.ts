import type { DeviceId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { imageSighting, runPushRegistration } from "~/server/db/schema";
import { deriveAndStoreImageCapture } from "~/server/domains/image/repo/image-capture-derivation";

/**
 * A device's reported sightings go with it, and every affected image is
 * re-derived in the same transaction so its capture fields never reflect a
 * sighting that no longer exists.
 */
export const deleteDeviceSightings = async (
  tx: DrizzleTransaction,
  ids: DeviceId[],
): Promise<void> => {
  const removed = await tx
    .delete(imageSighting)
    .where(inArray(imageSighting.deviceId, ids))
    .returning({ imageId: imageSighting.imageId });
  for (const imageId of uniq(removed.map((row) => row.imageId)))
    await deriveAndStoreImageCapture(tx, parseEntityId("image", imageId));
};

/** A removed install's Run push registrations go with it. */
export const deleteDevicePushRegistrations = async (
  tx: DrizzleTransaction,
  ids: DeviceId[],
): Promise<void> => {
  await tx
    .delete(runPushRegistration)
    .where(inArray(runPushRegistration.deviceId, ids));
};

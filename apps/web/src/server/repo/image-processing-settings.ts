import { imageProcessingSettings } from "@cubby/schemas/maintenance";
import { eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { appSettings } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";

// A namespaced settings row, not an import session or a processing run.
export const IMAGE_PROCESSING_SETTINGS_ID =
  "00000000-0000-4000-8000-000000000071";
export const IMAGE_PROCESSING_SETTINGS_DEFAULTS = {
  enabled: false,
  paused: true,
};

export async function readImageProcessingSettings(
  db: Database | DrizzleTransaction,
  options?: { lock?: boolean },
) {
  const query = unwrapDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, IMAGE_PROCESSING_SETTINGS_ID));
  const rows = options?.lock ? await query.for("update") : await query;
  const row = rows[0];
  return row?.metadata
    ? imageProcessingSettings.parse(row.metadata)
    : IMAGE_PROCESSING_SETTINGS_DEFAULTS;
}

/**
 * Serialize a lease against pause/resume updates. Creating the default row in
 * the same transaction gives even a fresh installation a concrete row lock.
 */
export async function mayClaimImageProcessingJob(
  tx: DrizzleTransaction,
): Promise<boolean> {
  await tx
    .insert(appSettings)
    .values({
      id: IMAGE_PROCESSING_SETTINGS_ID,
      metadata: IMAGE_PROCESSING_SETTINGS_DEFAULTS,
    })
    .onConflictDoNothing();
  return !(await readImageProcessingSettings(tx, { lock: true })).paused;
}

/**
 * App Settings Repository
 *
 * Provides functions to get and update app-wide settings stored in a singleton table.
 * Replaces organization metadata for storing config like Google Sheets connection.
 */

import type { Database } from "~/server/db";
import { appSettings } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Get the app settings singleton record.
 * Creates one if it doesn't exist.
 */
export async function getAppSettings(
  db: Database,
): Promise<{ metadata: Record<string, unknown> | null }> {
  const dbClient = getDb(db);

  // Try to get existing settings
  const existing = await dbClient.query.appSettings.findFirst();

  if (existing) {
    return { metadata: existing.metadata };
  }

  // Create initial settings record
  const [created] = await dbClient
    .insert(appSettings)
    .values({ metadata: {} })
    .returning();

  return { metadata: created?.metadata ?? null };
}

/**
 * Update the app settings metadata.
 * Creates the settings record if it doesn't exist.
 */
export async function updateAppSettingsMetadata(
  db: Database,
  newMetadata: string,
): Promise<void> {
  const dbClient = getDb(db);

  // Get existing to check if we need to create
  const existing = await dbClient.query.appSettings.findFirst();

  if (existing) {
    await dbClient
      .update(appSettings)
      .set({ metadata: JSON.parse(newMetadata) as Record<string, unknown> });
  } else {
    await dbClient
      .insert(appSettings)
      .values({ metadata: JSON.parse(newMetadata) as Record<string, unknown> });
  }
}

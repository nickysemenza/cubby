import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { appSettings } from "~/server/db/schema";
import { withTransaction } from "~/server/repo/database-helpers";

const SETTINGS_ID = "00000000-0000-4000-8000-000000000072";
const COOLDOWN_MS = 60 * 60_000;
const stateSchema = z.object({ lastTriggeredAt: z.iso.datetime().optional() });

/** One household-wide claim for both app openings and the daily backstop. */
export async function claimCatchUp(
  db: Database,
  now = new Date(),
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await tx
      .insert(appSettings)
      .values({ id: SETTINGS_ID, metadata: {} })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ metadata: appSettings.metadata })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ID))
      .for("update");
    const previous = stateSchema.parse(row?.metadata ?? {}).lastTriggeredAt;
    if (previous && now.getTime() - Date.parse(previous) < COOLDOWN_MS)
      return false;
    await tx
      .update(appSettings)
      .set({ metadata: { lastTriggeredAt: now.toISOString() }, updatedAt: now })
      .where(eq(appSettings.id, SETTINGS_ID));
    return true;
  });
}

/** A failed queue handoff must not spend the next hour of catch-up eligibility. */
export async function releaseCatchUpClaim(
  db: Database,
  claimedAt: Date,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const [row] = await tx
      .select({ metadata: appSettings.metadata })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ID))
      .for("update");
    if (
      stateSchema.parse(row?.metadata ?? {}).lastTriggeredAt !==
      claimedAt.toISOString()
    )
      return;
    await tx
      .update(appSettings)
      .set({ metadata: {}, updatedAt: new Date() })
      .where(eq(appSettings.id, SETTINGS_ID));
  });
}

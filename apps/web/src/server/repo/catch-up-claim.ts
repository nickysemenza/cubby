import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { appSettings } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

const SETTINGS_ID = "00000000-0000-4000-8000-000000000072";
const COOLDOWN_MS = 60 * 60_000;

/** One household-wide claim for both app openings and the daily backstop. */
export async function claimCatchUp(
  db: Database,
  now = new Date(),
): Promise<boolean> {
  const metadata = { lastTriggeredAt: now.toISOString() };
  const cutoff = new Date(now.getTime() - COOLDOWN_MS);
  const [claimed] = await getDb(db)
    .insert(appSettings)
    .values({ id: SETTINGS_ID, metadata, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { metadata, updatedAt: now },
      setWhere: sql`coalesce((${appSettings.metadata}->>'lastTriggeredAt')::timestamptz, '-infinity'::timestamptz) <= ${cutoff}`,
    })
    .returning({ id: appSettings.id });
  return claimed !== undefined;
}

/** A failed queue handoff must not spend the next hour of catch-up eligibility. */
export async function releaseCatchUpClaim(
  db: Database,
  claimedAt: Date,
): Promise<void> {
  await getDb(db)
    .update(appSettings)
    .set({ metadata: {}, updatedAt: new Date() })
    .where(
      and(
        eq(appSettings.id, SETTINGS_ID),
        sql`${appSettings.metadata}->>'lastTriggeredAt' = ${claimedAt.toISOString()}`,
      ),
    );
}

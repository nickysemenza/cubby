import type { ActorContext } from "@cubby/schemas/context";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { appSettings } from "~/server/db/schema";

const SETTINGS_ID = "00000000-0000-4000-8000-000000000080";
const automaticAiStop = z.object({
  stoppedAt: z.iso.datetime(),
  stoppedBy: z.string(),
});
export async function readAutomaticAiStop(db: Database) {
  const [row] = await getDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  return row ? automaticAiStop.parse(row.metadata) : null;
}
/** The first member Stop stands until resumed; admission checks it before send. */
export async function stopAutomaticAi(db: Database, actor: ActorContext) {
  await getDb(db)
    .insert(appSettings)
    .values({
      id: SETTINGS_ID,
      metadata: automaticAiStop.parse({
        stoppedAt: new Date().toISOString(),
        stoppedBy: actor.userId,
      }),
    })
    .onConflictDoNothing();
  return { parked: 0 };
}
export async function resumeAutomaticAi(db: Database) {
  await getDb(db).delete(appSettings).where(eq(appSettings.id, SETTINGS_ID));
  return { resumed: 0 };
}

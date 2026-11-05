/**
 * A member's Stop for automatic AI work, which has no Run to stop. While it stands,
 * discovery admits nothing and owed automatic evaluations stay parked. It lasts until a
 * member resumes. Work owned by a Run keeps that Run's own Stop.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { PENDING_AI_STATES } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { aiEvaluation, appSettings } from "~/server/db/schema";

import { lockAiRefreshScheduling } from "./ai-refresh-admission";

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

const automaticPending = () =>
  and(
    isNull(aiEvaluation.runId),
    inArray(aiEvaluation.state, [...PENDING_AI_STATES]),
  );

/**
 * Park what is owed, and make any attempt in flight unable to publish. It holds the lock
 * admission takes, so no page can admit work after this commits. The first Stop's record
 * stands if a member presses it twice.
 */
export async function stopAutomaticAi(db: Database, actor: ActorContext) {
  return withTransactionDatabase(db, async (tx) => {
    await lockAiRefreshScheduling(tx);
    await getDb(tx)
      .insert(appSettings)
      .values({
        id: SETTINGS_ID,
        metadata: automaticAiStop.parse({
          stoppedAt: new Date().toISOString(),
          stoppedBy: actor.userId,
        }),
      })
      .onConflictDoNothing();
    const parked = await getDb(tx)
      .update(aiEvaluation)
      .set({
        runAt: null,
        waitCause: null,
        leaseStale: sql`${aiEvaluation.leaseToken} IS NOT NULL`,
      })
      .where(and(automaticPending(), isNotNull(aiEvaluation.runAt)))
      .returning({ id: aiEvaluation.id });
    return { parked: parked.length };
  });
}

/** Lift the Stop and owe what it parked again. */
export async function resumeAutomaticAi(db: Database) {
  return withTransactionDatabase(db, async (tx) => {
    await lockAiRefreshScheduling(tx);
    await getDb(tx).delete(appSettings).where(eq(appSettings.id, SETTINGS_ID));
    const resumed = await getDb(tx)
      .update(aiEvaluation)
      .set({ runAt: sql`now()` })
      .where(and(automaticPending(), isNull(aiEvaluation.runAt)))
      .returning({ id: aiEvaluation.id });
    return { resumed: resumed.length };
  });
}

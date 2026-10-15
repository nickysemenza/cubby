import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  email,
  emailClassificationObservation,
  run,
} from "~/server/db/schema";
import { emailMemberClassificationSql } from "~/server/domains/email/repo/email-sql";

/** The rows an uncertain-Email refresh evaluation reads and settles. */

export type EmailRefreshEvaluation = typeof aiEvaluation.$inferSelect;

/** The target Email with its member override, and the refresh's owning Run. */
export async function loadEmailRefreshTarget(
  db: Database,
  evaluation: EmailRefreshEvaluation,
) {
  const [[current], [owner]] = await Promise.all([
    getDb(db)
      .select({ item: email, member: emailMemberClassificationSql() })
      .from(email)
      .where(eq(email.id, evaluation.target.recordId)),
    getDb(db).select().from(run).where(eq(run.id, evaluation.runId)),
  ]);
  return { current, owner };
}

export async function latestClassificationObservation(
  db: Database,
  emailId: string,
) {
  const [observation] = await getDb(db)
    .select()
    .from(emailClassificationObservation)
    .where(eq(emailClassificationObservation.emailId, emailId))
    .orderBy(desc(emailClassificationObservation.createdAt))
    .limit(1);
  return observation;
}

/** An attempt that did not publish settles `blocked` with `receipt`; a completed one is left alone. */
export async function blockUnpublishedEmailRefresh(
  db: Database,
  evaluationId: EmailRefreshEvaluation["id"],
  token: string,
  receipt: (typeof aiEvaluation.$inferInsert)["receipt"],
) {
  const [published] = await getDb(db)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, evaluationId));
  if (published?.state === "completed") return;
  await getDb(db)
    .update(aiEvaluation)
    .set({
      state: "blocked",
      receipt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiEvaluation.id, evaluationId),
        eq(aiEvaluation.attemptToken, token),
        inArray(aiEvaluation.state, ["running", "result_ready"]),
      ),
    );
}

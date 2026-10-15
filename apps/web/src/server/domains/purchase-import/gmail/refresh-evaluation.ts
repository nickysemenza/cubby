import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { userId } from "@cubby/schemas/identifiers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { dependenciesCurrent } from "~/server/ai/refresh-policy";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  email,
  emailClassificationObservation,
  run,
} from "~/server/db/schema";
import { emailMemberClassificationSql } from "~/server/domains/email/repo/email-sql";

import { ingestGmailMessages } from "./ingest";
import { gmailProviderForUser } from "./provider";

export async function refreshEmailEvaluation(
  db: Database,
  evaluation: typeof aiEvaluation.$inferSelect,
  ports: Pick<
    Parameters<typeof ingestGmailMessages>[2],
    "triage" | "relevance" | "storage"
  > = {},
) {
  if (!evaluation.attemptToken)
    throw new Error("Email refresh has no attempt token");
  const [[current], [owner], activation] = await Promise.all([
    getDb(db)
      .select({ item: email, member: emailMemberClassificationSql() })
      .from(email)
      .where(eq(email.id, evaluation.target.recordId)),
    getDb(db).select().from(run).where(eq(run.id, evaluation.runId)),
    readAiRefreshActivation(db),
  ]);
  const input = aiRefreshRunInput.parse(owner?.input);
  if (
    !current ||
    !owner ||
    !owner.actorUserId ||
    current.member ||
    current.item.classification !== "uncertain"
  )
    throw new Error("AI evaluation member decision is obsolete");
  const snapshot = z
    .object({ checksum: z.string().nullable() })
    .parse(evaluation.snapshot);
  if (snapshot.checksum !== current.item.checksum)
    throw new Error("AI evaluation target changed during inference");
  const [observation] = await getDb(db)
    .select()
    .from(emailClassificationObservation)
    .where(eq(emailClassificationObservation.emailId, current.item.id))
    .orderBy(desc(emailClassificationObservation.createdAt))
    .limit(1);
  const reusable = (feature: string) => {
    const stamp = observation?.provenance?.dependencies.find(
      (entry) => entry.feature === feature,
    );
    return Boolean(
      stamp &&
      activation &&
      observation?.checksum === current.item.checksum &&
      dependenciesCurrent(
        { ...evaluation.provenance, dependencies: [stamp] },
        activation.manifest,
      ),
    );
  };
  const provider = await gmailProviderForUser(
    db,
    userId.parse(owner.actorUserId),
  );
  const outcome = await ingestGmailMessages(db, provider, {
    ...ports,
    ledgerPartyId: current.item.ledgerPartyId,
    mailboxId: current.item.mailboxId,
    messageIds: [current.item.messageId],
    runId: owner.id,
    reclassify: true,
    refreshStage: reusable("mailbox-triage")
      ? "mailbox-relevance"
      : "mailbox-triage",
    refreshSkipRelevance: reusable("mailbox-relevance"),
    refreshDependencies: observation?.provenance?.dependencies,
    evaluation: { id: evaluation.id, token: evaluation.attemptToken },
  });
  const [published] = await getDb(db)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, evaluation.id));
  if (published?.state !== "completed") {
    // The acquisition fence can decline before publication (missing/historical source).
    await getDb(db)
      .update(aiEvaluation)
      .set({
        state: "blocked",
        receipt: JSON.parse(
          JSON.stringify({
            reason: "source_unavailable_or_protected",
            outcome,
            authorization: Boolean(input.executionAuthorization),
          }),
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiEvaluation.id, evaluation.id),
          eq(aiEvaluation.attemptToken, evaluation.attemptToken),
          inArray(aiEvaluation.state, ["running", "result_ready"]),
        ),
      );
  }
}

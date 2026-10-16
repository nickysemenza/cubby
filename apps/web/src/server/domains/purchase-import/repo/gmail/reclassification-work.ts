import {
  executionAuthorizationRef,
  type ExecutionAuthorizationRef,
} from "@cubby/schemas/execution-authorization";
import {
  selectDecisionModel,
  supportedDecisionModelSchema,
} from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { compiledRefreshManifest } from "~/server/ai/policy/refresh-manifest";
import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { aiEvaluation, email, run } from "~/server/db/schema";

export const reclassificationSnapshot = z.object({
  publicId: z.string(),
  checksum: z.string().nullable(),
  decisionModel: supportedDecisionModelSchema,
  executionAuthorization: executionAuthorizationRef,
  authorizationHistory: z.array(executionAuthorizationRef).default([]),
  minimumBudgetMicroUSD: z.number().int().nonnegative().optional(),
});

export async function prepareReclassification(
  db: Database,
  runId: typeof run.$inferSelect.id,
  emails: readonly (typeof email.$inferSelect)[],
  authorization: ExecutionAuthorizationRef,
  decisionModel = selectDecisionModel(),
) {
  const manifest = await compiledRefreshManifest();
  for (const [sequence, item] of emails.entries()) {
    const inputFingerprint = await sha256Hex(
      JSON.stringify({ checksum: item.checksum, decisionModel, manifest }),
    );
    await enqueueAiEvaluation(
      db,
      {
        runId,
        executionKind: "mail_reclassify",
        shareKey: await sha256Hex(
          JSON.stringify({
            kind: "mail_reclassify",
            owner: item.ledgerPartyId,
            mailboxId: item.mailboxId,
            emailId: item.id,
            inputFingerprint,
          }),
        ),
        feature: "mailbox-relevance",
        target: {
          kind: "email",
          entity: "email",
          recordId: item.id,
          field: null,
          assessmentIds: [],
        },
        provenance: {
          dependencies: [],
          inputFingerprint,
          optionFingerprint: "",
          model: decisionModel,
        },
        snapshot: reclassificationSnapshot.parse({
          publicId: item.shortcode,
          checksum: item.checksum,
          decisionModel,
          executionAuthorization: authorization,
        }),
      },
      sequence,
    );
  }
}

export type ReclassificationEvaluation = typeof aiEvaluation.$inferSelect;

/** The reclassification's owning Run and its live target Email, if any. */
export async function loadReclassificationTarget(
  db: Database,
  evaluation: ReclassificationEvaluation,
) {
  const [[owner], [current]] = await Promise.all([
    getDb(db).select().from(run).where(eq(run.id, evaluation.runId)),
    getDb(db)
      .select()
      .from(email)
      .where(and(eq(email.id, evaluation.target.recordId), notDeleted(email))),
  ]);
  return { owner, current };
}

/** Rebind the attempt's snapshot; a stale attempt token writes nothing. */
export async function saveReclassificationSnapshot(
  db: Database,
  evaluationId: ReclassificationEvaluation["id"],
  token: string,
  snapshot: z.input<typeof reclassificationSnapshot>,
) {
  await getDb(db)
    .update(aiEvaluation)
    .set({ snapshot })
    .where(
      and(
        eq(aiEvaluation.id, evaluationId),
        eq(aiEvaluation.attemptToken, token),
      ),
    );
}

export async function readEvaluationState(
  db: Database,
  evaluationId: ReclassificationEvaluation["id"],
) {
  const [published] = await getDb(db)
    .select({ state: aiEvaluation.state })
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, evaluationId));
  return published?.state;
}

export async function readReclassifiedEmail(db: Database, emailId: string) {
  const [after] = await getDb(db)
    .select()
    .from(email)
    .where(eq(email.id, emailId));
  return after;
}

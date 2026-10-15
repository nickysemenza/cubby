import {
  executionAuthorizationRef,
  type ExecutionAuthorizationRef,
} from "@cubby/schemas/execution-authorization";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import {
  selectDecisionModel,
  supportedDecisionModelSchema,
} from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { compiledRefreshManifest } from "~/server/ai/refresh-policy";
import { publishAiEvaluation } from "~/server/ai/repo/ai-evaluation";
import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { aiEvaluation, email, run } from "~/server/db/schema";
import { assertExecutionAuthorization } from "~/server/domains/run/service/execution-authorization";
import {
  executionRequestForRun,
  withRunExecutionAuthorization,
} from "~/server/domains/run/service/execution-context";

import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";
import {
  deferClassificationRefresh,
  publishGmailEvidence,
} from "./admitted-source";
import { ingestGmailMessages } from "./ingest";
import { gmailProviderForUser } from "./provider";
import { mailboxApproval } from "./reclassify";

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

export type ReclassificationPorts = Pick<
  Parameters<typeof ingestGmailMessages>[2],
  "triage" | "relevance" | "candidateChoice" | "storage"
>;

export async function executeReclassificationTarget(
  db: Database,
  evaluation: typeof aiEvaluation.$inferSelect,
  ports: ReclassificationPorts = {},
) {
  const token = evaluation.attemptToken;
  if (!token) throw new Error("Reclassification has no attempt token");
  const [[owner], [current]] = await Promise.all([
    getDb(db).select().from(run).where(eq(run.id, evaluation.runId)),
    getDb(db)
      .select()
      .from(email)
      .where(and(eq(email.id, evaluation.target.recordId), notDeleted(email))),
  ]);
  if (!owner) throw new Error("Reclassification Run no longer exists");
  const input = mailReclassifyRunInput.parse(owner.input);
  const settle = async (outcome: "removed" | "frozen") => {
    await publishGmailEvidence(
      db,
      {
        ledgerPartyId: owner.ledgerPartyId!,
        mailboxId: input.mailboxId,
        messageId: current?.messageId ?? "",
        runId: owner.id,
        executionPolicy: "classification_only",
        expected: current ?? null,
        evaluation: { id: evaluation.id, token, reclassification: true },
      },
      async () => {
        if (outcome === "frozen")
          throw new Error(
            "Email eligibility changed before its frozen receipt; retrying",
          );
        return { kind: "removed" };
      },
    );
  };
  if (!current)
    return publishAiEvaluation(db, evaluation.id, token, async () => ({
      result: {
        id: reclassificationSnapshot.parse(evaluation.snapshot).publicId,
        outcome: "removed",
        classification: null,
        stage: null,
        conflict: false,
        error: null,
      },
    }));
  if (
    current.ledgerPartyId !== owner.ledgerPartyId ||
    current.mailboxId !== input.mailboxId
  )
    throw new Error(
      "Reclassification Email is outside its member/mailbox roster",
    );
  if (
    current.classificationVersion === HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION ||
    (await deferClassificationRefresh(db, "classification_only", current))
  )
    return settle("frozen");
  const snapshot = reclassificationSnapshot.parse(evaluation.snapshot);
  let authorization = snapshot.executionAuthorization;
  try {
    const request = await withRunExecutionAuthorization(
      owner.id,
      authorization,
      () => executionRequestForRun(db, owner.id),
    );
    if (!request)
      throw new Error("Reclassification has no bound execution approval");
    await assertExecutionAuthorization(db, request, {
      minimumBudgetMicroUSD: snapshot.minimumBudgetMicroUSD,
    });
  } catch {
    // SILENT: a failed binding is replaced by the newest currently usable mailbox approval.
    authorization = await mailboxApproval(
      db,
      { userId: owner.actorUserId, ledgerPartyId: current.ledgerPartyId },
      input.mailboxId,
      { minimumBudgetMicroUSD: snapshot.minimumBudgetMicroUSD, newest: true },
    );
  }
  const changedBinding =
    authorization.runId !== snapshot.executionAuthorization.runId ||
    authorization.approvalFingerprint !==
      snapshot.executionAuthorization.approvalFingerprint;
  const nextSnapshot = {
    ...snapshot,
    checksum: current.checksum,
    executionAuthorization: authorization,
    authorizationHistory: changedBinding
      ? [...snapshot.authorizationHistory, snapshot.executionAuthorization]
      : snapshot.authorizationHistory,
  };
  await getDb(db)
    .update(aiEvaluation)
    .set({ snapshot: nextSnapshot })
    .where(
      and(
        eq(aiEvaluation.id, evaluation.id),
        eq(aiEvaluation.attemptToken, token),
      ),
    );
  await withRunExecutionAuthorization(
    owner.id,
    authorization,
    async () => {
      const provider = await gmailProviderForUser(
        db,
        owner.actorUserId,
        input.mailboxId,
      );
      const triage =
        ports.triage ??
        (await import("./triage-model")).productionMailTriage(
          db,
          owner.id,
          undefined,
          snapshot.decisionModel,
        );
      await ingestGmailMessages(db, provider, {
        ...ports,
        triage,
        ledgerPartyId: current.ledgerPartyId,
        mailboxId: input.mailboxId,
        messageIds: [current.messageId],
        runId: owner.id,
        reclassify: true,
        evaluation: { id: evaluation.id, token, reclassification: true },
      });
    },
    { id: evaluation.id, token },
  );
  const [published] = await getDb(db)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, evaluation.id));
  if (published && !["running", "result_ready"].includes(published.state))
    return;
  const [after] = await getDb(db)
    .select()
    .from(email)
    .where(eq(email.id, current.id));
  if (
    after &&
    (await deferClassificationRefresh(db, "classification_only", after))
  )
    return settle("frozen");
  throw new Error("Reclassification evidence changed during publication");
}

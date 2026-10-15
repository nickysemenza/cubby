import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";

import { publishAiEvaluation } from "~/server/ai/repo/ai-evaluation";
import type { Database } from "~/server/db";
import { assertExecutionAuthorization } from "~/server/domains/run/repo/execution-authorization";
import {
  executionRequestForRun,
  withRunExecutionAuthorization,
} from "~/server/domains/run/repo/execution-context";

import {
  deferClassificationRefresh,
  publishGmailEvidence,
} from "../../repo/gmail/admitted-source";
import { gmailProviderForUser } from "../../repo/gmail/provider";
import {
  loadReclassificationTarget,
  readEvaluationState,
  readReclassifiedEmail,
  reclassificationSnapshot,
  saveReclassificationSnapshot,
  type ReclassificationEvaluation,
} from "../../repo/gmail/reclassification-work";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../../repo/mail-source-identity";
import { ingestGmailMessages } from "./ingest";
import { mailboxApproval } from "./reclassify";

export type ReclassificationPorts = Pick<
  Parameters<typeof ingestGmailMessages>[2],
  "triage" | "relevance" | "candidateChoice" | "storage"
>;

export async function executeReclassificationTarget(
  db: Database,
  evaluation: ReclassificationEvaluation,
  ports: ReclassificationPorts = {},
) {
  const token = evaluation.attemptToken;
  if (!token) throw new Error("Reclassification has no attempt token");
  const { owner, current } = await loadReclassificationTarget(db, evaluation);
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
  await saveReclassificationSnapshot(db, evaluation.id, token, nextSnapshot);
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
  const published = await readEvaluationState(db, evaluation.id);
  if (published && !["running", "result_ready"].includes(published)) return;
  const after = await readReclassifiedEmail(db, current.id);
  if (
    after &&
    (await deferClassificationRefresh(db, "classification_only", after))
  )
    return settle("frozen");
  throw new Error("Reclassification evidence changed during publication");
}

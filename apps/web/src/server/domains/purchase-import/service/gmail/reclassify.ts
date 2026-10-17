import type { ActorContext } from "@cubby/schemas/context";
import {
  emailAtChecksum,
  reclassifyEmailsInput,
  reclassifyEmailsOut,
  rerunEmailPreviewOut,
  type EmailAtChecksum,
  type ReclassifyEmailsInput,
  type ReclassifyEmailsOut,
  type RerunEmailPreviewOut,
} from "@cubby/schemas/email-actions";
import {
  mailTriagePreviewInput,
  mailTriagePreviewOut,
  type MailTriagePreviewInput,
  type MailTriagePreviewOut,
  type MailImageEvidence,
} from "@cubby/schemas/mailbox-research";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { groupBy } from "es-toolkit";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { listAiUsageForRun } from "~/server/ai/repo/ai-usage";
import type { Database } from "~/server/db";
import { normalizeMessage } from "~/server/domains/purchase-import/repo/gmail/normalize";
import { type WorkflowLauncher } from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { publishGmailEvidence } from "../../repo/gmail/admitted-source";
import { recordEmailCandidateObservation } from "../../repo/gmail/observations";
import { gmailProviderForUser } from "../../repo/gmail/provider";
import {
  finishReclassifyRun,
  ownedEmailRows,
  ownedEmails,
  startPreparedReclassifyRuns,
  startReclassifyRun,
} from "../../repo/gmail/reclassify-state";
import {
  extractEmailCandidatePreview,
  type EmailCandidateChoice,
} from "./candidate-extraction";
import { ingestGmailMessages } from "./ingest";
import {
  interpretMailRelevance,
  type MailRelevance,
  type RelevanceImagePorts,
} from "./relevance";
import {
  gmailOriginalComplete,
  routeGmailMessage,
  type MailTriage,
} from "./triage";

type IngestPorts = Pick<
  Parameters<typeof ingestGmailMessages>[2],
  "triage" | "relevance" | "candidateChoice" | "storage"
>;
/** Freeze member-requested work; Gmail and model IO belong to the Workflow. */
export async function reclassifyEmails(
  db: Database,
  rawInput: ReclassifyEmailsInput,
  actor: ActorContext,
  ports: IngestPorts & { launcher?: WorkflowLauncher } = {},
): Promise<ReclassifyEmailsOut> {
  const input = reclassifyEmailsInput.parse(rawInput);
  const emails = await ownedEmails(db, [...new Set(input.ids)], actor);
  const groups = Object.values(
    groupBy(
      emails,
      (email) => `${email.ledgerPartyId}\u0000${email.mailboxId}`,
    ),
  );
  const created = await startPreparedReclassifyRuns(db, actor, groups);
  for (const item of created)
    await launchWorkflowRun(
      db,
      {
        runId: item.id,
        purpose: "mail_reclassify",
      },
      ports.launcher,
    );
  return reclassifyEmailsOut.parse({
    runIds: created.map((item) => item.shortcode),
  });
}

/** Rerun the cheap extraction preview for one related, retained Email. */
export async function rerunEmailPreview(
  db: Database,
  rawInput: EmailAtChecksum,
  actor: ActorContext,
  ports: { choose?: EmailCandidateChoice } = {},
): Promise<RerunEmailPreviewOut> {
  const input = emailAtChecksum.parse(rawInput);
  const [email] = await ownedEmails(db, [input.id], actor);
  if (!email || email.checksum !== input.expectedChecksum)
    throw new Error("Email evidence changed; refresh before rerunning.");
  if (email.classification !== "related")
    throw new Error("Only a related Email has an extraction preview.");
  const created = await startReclassifyRun(db, actor, "preview", [email]);
  try {
    const preview = await extractEmailCandidatePreview(
      db,
      {
        emailId: email.id,
        ledgerPartyId: email.ledgerPartyId,
        runId: created.id,
      },
      ports,
    );
    const published = await publishGmailEvidence(
      db,
      {
        ledgerPartyId: email.ledgerPartyId,
        mailboxId: email.mailboxId,
        messageId: email.messageId,
        runId: created.id,
        executionPolicy: "classification_only",
        expected: email,
      },
      async (tx) => {
        await recordEmailCandidateObservation(tx, {
          emailId: email.id,
          preview,
        });
        return preview;
      },
    );
    if (!published)
      throw new Error(
        "Email changed or was admitted to an import during the preview; refresh before rerunning.",
      );
    await finishReclassifyRun(db, created.id, []);
    return rerunEmailPreviewOut.parse({
      runId: created.shortcode,
      status: published.status,
      reason: published.status === "abstained" ? published.reason : null,
    });
  } catch (error) {
    await finishReclassifyRun(db, created.id, [
      scrubErrorMessage(error instanceof Error ? error.message : String(error)),
    ]);
    throw error;
  }
}

/**
 * Preview the classification stages from the Gmail original without publication.
 * Only the diagnostic Run and its model usage are persisted.
 */
export async function previewMailTriage(
  db: Database,
  rawInput: MailTriagePreviewInput,
  actor: ActorContext,
  ports: {
    triage?: MailTriage;
    relevance?: MailRelevance;
    images?: RelevanceImagePorts;
  } = {},
): Promise<MailTriagePreviewOut> {
  const input = mailTriagePreviewInput.parse(rawInput);
  const [row] = await ownedEmailRows(db, actor, {
    mailboxId: input.mailboxId,
    messageId: input.messageId,
  });
  if (!row)
    throw new Error(
      `No live Gmail Email owned by this member: ${input.mailboxId} ${input.messageId}`,
    );
  const { email } = row;
  const created = await startReclassifyRun(db, actor, "triage_preview", [
    email,
  ]);
  const startedAt = Date.now();
  try {
    const provider = await gmailProviderForUser(
      db,
      actor.userId,
      email.mailboxId,
    );
    const message = await provider.getMessage(email.messageId);
    let model: MailTriagePreviewOut["triage"]["model"] = null;
    let triageCalls = 0;
    let relevanceCalls = 0;
    const triage =
      ports.triage ??
      (await import("./triage-model")).productionMailTriage(
        db,
        created.id,
        (call) => {
          triageCalls++;
          model = supportedDecisionModelSchema.parse(call.model);
        },
        input.decisionModel,
      );
    const normalized = normalizeMessage(email.mailboxId, message);
    const { decision, view } = await routeGmailMessage(
      message,
      normalized,
      triage,
    );
    let relevance: MailTriagePreviewOut["relevance"] = null;
    let relevanceModel: string | null = null;
    let imageEvidence: MailImageEvidence | null = null;
    if (decision.classification === "uncertain") {
      const interpret =
        ports.relevance ??
        (await import("./triage-model")).productionMailRelevance(
          db,
          created.id,
          (call) => {
            relevanceCalls++;
            relevanceModel = call.model;
          },
        );
      relevance = await interpretMailRelevance(
        provider,
        normalized,
        interpret,
        gmailOriginalComplete(message, normalized),
        undefined,
        {
          ...ports.images,
          onEvidence: (evidence) => {
            imageEvidence = evidence;
          },
        },
      );
    }
    const usage = await listAiUsageForRun(db, created.id, { limit: 100 });
    // Usage is queued telemetry; a missing row is not a free model call.
    const recordedCalls = (operation: string) =>
      usage.records.filter(
        (call) => call.operation === operation && call.status === "succeeded",
      ).length;
    const accountingPending =
      recordedCalls("mailbox-triage") < triageCalls ||
      recordedCalls("mailbox-relevance") < relevanceCalls;
    await finishReclassifyRun(db, created.id, []);
    return mailTriagePreviewOut.parse({
      ...(relevance
        ? {
            classification: relevance.classification,
            stage: "model",
            reason:
              relevance.reason ??
              `The relevance model classified the message ${relevance.classification}`,
          }
        : decision),
      model: relevance ? relevanceModel : model,
      runId: created.shortcode,
      triage: { ...decision, model },
      relevance,
      imageEvidence,
      usage: {
        calls: triageCalls + relevanceCalls,
        accountingPending,
        elapsedMs: Date.now() - startedAt,
        standardCost:
          accountingPending || usage.standardUnpricedCount
            ? null
            : usage.standardCost,
        chargedCost:
          accountingPending || usage.chargedUnpricedCount
            ? null
            : usage.chargedCost,
      },
      view,
    });
  } catch (error) {
    await finishReclassifyRun(db, created.id, [
      scrubErrorMessage(error instanceof Error ? error.message : String(error)),
    ]);
    throw error;
  }
}

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
import { parseEntityId } from "@cubby/schemas/identifiers";
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
import { latestExecutionAuthorization } from "~/server/domains/run/repo/execution-context";
import { type WorkflowLauncher } from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { publishGmailEvidence } from "../../repo/gmail/admitted-source";
import { recordEmailCandidateObservation } from "../../repo/gmail/observations";
import { gmailProviderForUser } from "../../repo/gmail/provider";
import {
  finishReclassifyRun,
  newestRunId,
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
/** Backfill, else continuous; an expired or revoked approval is unusable, not fatal. */
export async function mailboxApproval(
  db: Database,
  owner: { userId: ActorContext["userId"]; ledgerPartyId: string },
  mailboxId: string,
  options: { minimumBudgetMicroUSD?: number; newest?: boolean } = {},
) {
  const refused: string[] = [];
  const candidates: Awaited<ReturnType<typeof latestExecutionAuthorization>>[] =
    [];
  for (const kind of ["backfill", "continuous"] as const) {
    try {
      const ref = await latestExecutionAuthorization(
        db,
        {
          ...owner,
          ledgerPartyId: parseEntityId("ledgerParty", owner.ledgerPartyId),
        },
        mailboxId,
        kind,
        options.minimumBudgetMicroUSD,
      );
      if (ref && !options.newest) return ref;
      if (ref) candidates.push(ref);
    } catch (error) {
      refused.push(
        `${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (candidates.length) {
    const latestId = await newestRunId(
      db,
      candidates.flatMap((ref) => (ref ? [ref.runId] : [])),
    );
    const selected = candidates.find((ref) => ref?.runId === latestId);
    if (selected) return selected;
  }
  throw new Error(
    `Reclassify needs a usable Gmail execution approval for mailbox ${mailboxId}${refused.length ? ` (${refused.join("; ")})` : ""}.`,
  );
}

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
  // Settle every mailbox's authority before creating any requested work.
  const batches = await Promise.all(
    groups.map(async (group) => ({
      group,
      approval: await mailboxApproval(
        db,
        { userId: actor.userId, ledgerPartyId: group[0]!.ledgerPartyId },
        group[0]!.mailboxId,
      ),
    })),
  );
  const created = await startPreparedReclassifyRuns(db, actor, batches);
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
  const created = await startReclassifyRun(
    db,
    actor,
    "preview",
    [email],
    await mailboxApproval(
      db,
      { userId: actor.userId, ledgerPartyId: email.ledgerPartyId },
      email.mailboxId,
    ),
  );
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
  const created = await startReclassifyRun(
    db,
    actor,
    "triage_preview",
    [email],
    await mailboxApproval(
      db,
      { userId: actor.userId, ledgerPartyId: email.ledgerPartyId },
      email.mailboxId,
    ),
  );
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

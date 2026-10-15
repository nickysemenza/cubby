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
import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  mailTriagePreviewInput,
  mailTriagePreviewOut,
  type MailTriagePreviewInput,
  type MailTriagePreviewOut,
  type MailImageEvidence,
} from "@cubby/schemas/mailbox-research";
import {
  mailReclassifyRunInput,
  type MailReclassifyRunInput,
} from "@cubby/schemas/run-fields";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { groupBy } from "es-toolkit";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { email as emailTable, ledgerParty, run } from "~/server/db/schema";
import { listAiUsageForRun } from "~/server/repo/ai-usage";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";
import { latestExecutionAuthorization } from "~/server/runs/execution-context";
import { type WorkflowLauncher } from "~/server/workflow-runs/launcher";
import { launchWorkflowRun } from "~/server/workflow-runs/lifecycle";

import { publishGmailEvidence } from "./admitted-source";
import {
  extractEmailCandidatePreview,
  type EmailCandidateChoice,
} from "./candidate-extraction";
import { ingestGmailMessages } from "./ingest";
import { normalizeMessage } from "./normalize";
import { recordEmailCandidateObservation } from "./observations";
import { gmailProviderForUser } from "./provider";
import { prepareReclassification } from "./reclassification-work";
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
type OwnedEmail = typeof emailTable.$inferSelect;

async function ownedEmailRows(
  db: Database,
  actor: ActorContext,
  where: SQL | undefined,
) {
  if (actor.runId)
    throw new Error("Only a member without a Run can reclassify Emails.");
  return getDb(db)
    .select({ email: emailTable })
    .from(emailTable)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, emailTable.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(where, eq(emailTable.provider, "gmail"), notDeleted(emailTable)),
    );
}

async function ownedEmails(
  db: Database,
  codes: readonly string[],
  actor: ActorContext,
) {
  const rows = await ownedEmailRows(
    db,
    actor,
    inArray(emailTable.shortcode, [...codes]),
  );
  const found = new Map(rows.map(({ email }) => [email.shortcode, email]));
  const missing = codes.filter((code) => !found.has(code));
  if (missing.length)
    throw new Error(
      `No live Gmail Email owned by this member: ${missing.join(", ")}`,
    );
  return codes.map((code) => found.get(code)!);
}

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
    const [latest] = await getDb(db)
      .select({ id: run.id })
      .from(run)
      .where(
        inArray(
          run.id,
          candidates.flatMap((ref) => (ref ? [ref.runId] : [])),
        ),
      )
      .orderBy(desc(run.createdAt), desc(run.id))
      .limit(1);
    const selected = candidates.find((ref) => ref?.runId === latest?.id);
    if (selected) return selected;
  }
  throw new Error(
    `Reclassify needs a usable Gmail execution approval for mailbox ${mailboxId}${refused.length ? ` (${refused.join("; ")})` : ""}.`,
  );
}

async function finishReclassifyRun(
  db: Database,
  runId: RunId,
  notes: readonly string[],
  receiptFailure = false,
) {
  // A budget pause (`needs_review`) keeps its status and failure code.
  await getDb(db)
    .update(run)
    .set({
      status: receiptFailure ? "failed" : "completed",
      endedAt: new Date(),
      notes: notes.length ? notes.join("\n").slice(0, 2_000) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(run.id, runId), eq(run.status, "running")));
}

/**
 * One Run per mailbox holds the rerun's model usage and observations. It binds
 * the member's Gmail execution approval for that mailbox and never becomes the
 * Email's processing Run, so later discovery refreshes are not frozen by it.
 */
async function startReclassifyRun(
  db: Database,
  actor: ActorContext,
  mode: MailReclassifyRunInput["mode"],
  emails: readonly OwnedEmail[],
  executionAuthorization: Awaited<ReturnType<typeof mailboxApproval>>,
) {
  const [first] = emails;
  if (!first) throw new Error("Reclassify needs at least one Email.");
  const runId = await ensureRun(
    db,
    { ...actor, runId: null },
    {
      purpose: mode === "relevance" ? "mail_reclassify" : "background",
      trigger: "manual",
      status: "running",
      progress:
        mode === "relevance"
          ? {
              kind: "mail_reclassification",
              version: 1,
              complete: false,
              results: [],
              attempt: 0,
            }
          : undefined,
      input: mailReclassifyRunInput.parse({
        kind: "mail_reclassify",
        mode,
        executionAuthorization,
        mailboxId: first.mailboxId,
        emails: emails.map((email) => ({
          emailId: email.id,
          checksum: email.checksum,
        })),
      }),
    },
  );
  const [created] = await getDb(db)
    .select({ ledgerPartyId: run.ledgerPartyId, shortcode: run.shortcode })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1);
  if (created?.ledgerPartyId !== first.ledgerPartyId) {
    const message =
      "Reclassify Run owner differs from the Email owner; reclassify each member's Emails separately.";
    await finishReclassifyRun(db, runId, [message]);
    throw new Error(message);
  }
  return { id: runId, shortcode: created.shortcode };
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
  const created = await withTransactionDatabase(db, async (tx) => {
    const runs = [];
    for (const { group, approval } of batches) {
      const started = await startReclassifyRun(
        tx,
        actor,
        "relevance",
        group,
        approval,
      );
      await prepareReclassification(tx, started.id, group, approval);
      runs.push(started);
    }
    return runs;
  });
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
  const [row] = await ownedEmailRows(
    db,
    actor,
    and(
      eq(emailTable.mailboxId, input.mailboxId),
      eq(emailTable.messageId, input.messageId),
    ),
  );
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
    const triage =
      ports.triage ??
      (await import("./triage-model")).productionMailTriage(
        db,
        created.id,
        (call) => {
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
    const usage = await listAiUsageForRun(db, created.id, { limit: 1 });
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
        calls: usage.count,
        elapsedMs: Date.now() - startedAt,
        standardCost: usage.standardUnpricedCount ? null : usage.standardCost,
        chargedCost: usage.chargedUnpricedCount ? null : usage.chargedCost,
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

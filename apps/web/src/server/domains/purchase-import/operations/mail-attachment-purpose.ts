import type { ActorContext } from "@cubby/schemas/context";
import { eq } from "drizzle-orm";

import { wasm } from "~/lib/wasm";
import {
  decisionChoiceFitsContext,
  runDecisionChoice,
  runDecisionChoices,
  type DecisionChoiceResult,
  type DecisionPort,
} from "~/server/ai/decision-model";
import { MAIL_ATTACHMENT_PURPOSE_FEATURE } from "~/server/ai/policy/features";
import type { AiRunContext } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { orderMailAttachment } from "~/server/db/schema";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import {
  aiCallRunInput,
  ensureRun,
} from "~/server/domains/run/repo/ensure-run";

type AttachmentEvidence = Pick<
  typeof orderMailAttachment.$inferSelect,
  "filename" | "mimeType" | "checksum"
>;

export const attachmentEvidenceFingerprint = (attachment: AttachmentEvidence) =>
  JSON.stringify({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    checksum: attachment.checksum,
  });

function attachmentPrompts(
  mail: Pick<RetainedMail, "sender" | "subject" | "content" | "rawChecksum">,
  attachments: readonly AttachmentEvidence[],
) {
  const html = mail.content.bodyHtml
    ? wasm.compact_email_html(mail.content.bodyHtml)
    : null;
  return attachments.map((attachment) =>
    MAIL_ATTACHMENT_PURPOSE_FEATURE.prompt(
      JSON.stringify({
        email: {
          sender: mail.sender,
          subject: mail.subject,
          checksum: mail.rawChecksum,
          bodyText: mail.content.bodyText,
          htmlText: html?.text ?? null,
          htmlComplete: !html?.truncated,
        },
        attachment,
      }),
    ),
  );
}

const promotesDocument = (result: DecisionChoiceResult) =>
  result.confidence === "high" &&
  MAIL_ATTACHMENT_PURPOSE_FEATURE.choices[result.selectedIndex ?? -1] ===
    "purchase_document";

/** Only a confident useful-document decision promotes a file; uncertainty retains the original. */
export async function shouldPromoteMailAttachment(
  mail: Pick<RetainedMail, "sender" | "subject" | "content" | "rawChecksum">,
  attachment: AttachmentEvidence,
  usage: AiRunContext,
  port?: DecisionPort,
) {
  const prompt = attachmentPrompts(mail, [attachment])[0]!;
  if (!decisionChoiceFitsContext(prompt)) return false;
  const result = await runDecisionChoice({
    ...prompt,
    feature: MAIL_ATTACHMENT_PURPOSE_FEATURE,
    usage,
    port,
  });
  return promotesDocument(result);
}

/** Share email preparation and cache/model admission without changing attachment evidence. */
export async function shouldPromoteMailAttachments(
  mail: Pick<RetainedMail, "sender" | "subject" | "content" | "rawChecksum">,
  attachments: readonly AttachmentEvidence[],
  usage: AiRunContext,
  port?: DecisionPort,
) {
  if (!attachments.length) return [];
  const prompts = attachmentPrompts(mail, attachments);
  const eligible = prompts.flatMap((prompt, index) =>
    decisionChoiceFitsContext(prompt) ? [{ prompt, index }] : [],
  );
  const results = await runDecisionChoices(
    eligible.map(({ prompt }) => ({
      ...prompt,
      feature: MAIL_ATTACHMENT_PURPOSE_FEATURE,
      usage,
      port,
    })),
  );
  const promotions = attachments.map(() => false);
  eligible.forEach(({ index }, position) => {
    promotions[index] = promotesDocument(results[position]!);
  });
  return promotions;
}

/** Inference runs before the linking transaction; publication rechecks the exact evidence snapshot. */
export async function prepareMailAttachmentDecisions(
  db: Database,
  mail: RetainedMail,
  actor: ActorContext,
  port?: DecisionPort,
) {
  const rows = await getDb(db)
    .select()
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, mail.id));
  const decisions = new Map<
    string,
    { fingerprint: string; promote: boolean }
  >();
  const eligible = rows.filter(
    (attachment) => attachment.imageId || attachment.pendingObjectKey,
  );
  const promoted = new Map<string, boolean>();
  if (eligible.length) {
    const usage: AiRunContext = {
      db,
      runId: await ensureRun(db, actor, aiCallRunInput(actor)),
      operation: "mail-attachment-purpose",
    };
    const results = await shouldPromoteMailAttachments(
      mail,
      eligible.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        checksum: attachment.checksum,
      })),
      usage,
      port,
    );
    eligible.forEach((attachment, index) =>
      promoted.set(attachment.id, results[index]!),
    );
  }
  for (const attachment of rows) {
    decisions.set(attachment.id, {
      fingerprint: attachmentEvidenceFingerprint(attachment),
      promote: promoted.get(attachment.id) ?? false,
    });
  }
  return { mailChecksum: mail.rawChecksum, decisions };
}

export type PreparedMailAttachmentDecisions = Awaited<
  ReturnType<typeof prepareMailAttachmentDecisions>
>;

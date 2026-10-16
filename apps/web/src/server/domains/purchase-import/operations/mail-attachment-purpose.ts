import type { ActorContext } from "@cubby/schemas/context";
import { eq } from "drizzle-orm";

import { wasm } from "~/lib/wasm";
import {
  decisionChoiceFitsContext,
  runDecisionChoice,
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

/** Only a confident useful-document decision promotes a file; uncertainty retains the original. */
export async function shouldPromoteMailAttachment(
  mail: Pick<RetainedMail, "sender" | "subject" | "content" | "rawChecksum">,
  attachment: AttachmentEvidence,
  usage: AiRunContext,
  port?: DecisionPort,
) {
  const html = mail.content.bodyHtml
    ? wasm.compact_email_html(mail.content.bodyHtml)
    : null;
  const prompt = MAIL_ATTACHMENT_PURPOSE_FEATURE.prompt(
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
  );
  if (!decisionChoiceFitsContext(prompt)) return false;
  const result = await runDecisionChoice({
    ...prompt,
    feature: MAIL_ATTACHMENT_PURPOSE_FEATURE,
    usage,
    port,
  });
  return (
    result.confidence === "high" &&
    MAIL_ATTACHMENT_PURPOSE_FEATURE.choices[result.selectedIndex ?? -1] ===
      "purchase_document"
  );
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
  if (rows.length) {
    let usage: AiRunContext | undefined;
    for (const attachment of rows) {
      if (!attachment.imageId && !attachment.pendingObjectKey) {
        decisions.set(attachment.id, {
          fingerprint: attachmentEvidenceFingerprint(attachment),
          promote: false,
        });
        continue;
      }
      usage ??= {
        db,
        runId: await ensureRun(db, actor, aiCallRunInput(actor)),
        operation: "mail-attachment-purpose",
      };
      const promote = await shouldPromoteMailAttachment(
        mail,
        {
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          checksum: attachment.checksum,
        },
        usage,
        port,
      );
      decisions.set(attachment.id, {
        fingerprint: attachmentEvidenceFingerprint(attachment),
        promote,
      });
    }
  }
  return { mailChecksum: mail.rawChecksum, decisions };
}

export type PreparedMailAttachmentDecisions = Awaited<
  ReturnType<typeof prepareMailAttachmentDecisions>
>;

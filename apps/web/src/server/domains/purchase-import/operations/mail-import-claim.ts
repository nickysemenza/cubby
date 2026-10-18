/**
 * Pi's next admitted Email (`claim_next_import_work`), with its compact read.
 * Each Email stays the current item until `mail.resolve` or a mail-sourced
 * commit settles its target. Leading Emails a Mail import rule decides
 * (`service/mail-import-rule.ts`) are settled first, through `mail.resolve`'s
 * own writer, so the coordinator never spends a turn on them.
 *
 * Rules run inside the claim, not at admission or in the coordinator: the
 * claim is a leased Run operation whose replay returns its recorded result,
 * and each rule outcome is its own `mail.resolve` transaction, idempotent by
 * Email and outcome, so an interrupted claim leaves only settled Emails
 * settled and the next claim continues from the roster.
 */
import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  mailboxClassification,
  mailboxClassificationStage,
  mailReadAgentText,
  mailReadOut,
} from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { readMailRunSources } from "~/server/domains/purchase-import/repo/mail-run-membership";
import { AppError } from "~/server/errors/app-error";

import { mailReadContent } from "../repo/gmail/read-content";
import { senderProofVendor } from "../repo/import-vendor";
import {
  countRetainedMailAttachments,
  readMailRuleCandidates,
} from "../repo/mail-rule-evidence";
import {
  decideMailByRule,
  MAIL_IMPORT_RULE_REVISION,
  orderIdentifiers,
} from "../service/mail-import-rule";
import { readMail, resolveMail } from "./mail-tool";

type MailRunSource = Awaited<ReturnType<typeof readMailRunSources>>[number];

/** True when a rule settled the Email; false leaves it to the coordinator. */
async function settleByRule(
  db: Database,
  source: MailRunSource,
  actor: ActorContext,
  memberSelected: boolean,
) {
  const [mail] = await readRetainedMail(db, {
    ledgerPartyIds: [source.email.ledgerPartyId],
    orderMailIds: [source.orderMailId],
  });
  if (!mail || mail.rawChecksum !== source.checksum) return false;
  const content = mailReadContent(mail.content, {});
  // A later page or omitted evidence may reverse an apparent lifecycle notice.
  // The coordinator can page the read; a deterministic link cannot assume it.
  if (content.truncated || content.nextOffset !== null) return false;
  const text = [content.preheader, content.bodyText].filter(Boolean).join("\n");
  const proof = await senderProofVendor(db, mail.sender);
  const decision = decideMailByRule({
    subject: mail.subject,
    text,
    classification:
      mailboxClassification.safeParse(source.email.classification).data ?? null,
    classificationStage:
      mailboxClassificationStage.safeParse(source.email.classificationStage)
        .data ?? null,
    memberSelected,
    senderVendorId: proof?.vendor.id ?? null,
    retainedAttachments: await countRetainedMailAttachments(db, mail.id),
    candidates: await readMailRuleCandidates(db, {
      ledgerPartyId: mail.ledgerPartyId,
      orderIds: orderIdentifiers(mail.subject, text),
    }),
  });
  if (decision.kind === "coordinator") return false;
  const ref = {
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    checksum: mail.rawChecksum,
  };
  try {
    await resolveMail(
      db,
      decision.kind === "linked"
        ? {
            ...ref,
            disposition: {
              kind: "linked",
              event: decision.event,
              purchaseIds: [decision.purchaseId],
            },
          }
        : {
            ...ref,
            disposition: { kind: "unrelated", reason: decision.reason },
          },
      actor,
      undefined,
      undefined,
      { revision: MAIL_IMPORT_RULE_REVISION },
    );
  } catch (error) {
    // SILENT: a refusal `mail.resolve` would give the coordinator (a member's dismissal, another Purchase's link, changed evidence) hands it the Email instead.
    if (error instanceof AppError) return false;
    throw error;
  }
  return true;
}

/** The claimed Email's read, or the refusal the coordinator would get reading it. */
async function claimedRead(
  db: Database,
  ref: { mailboxId: string; messageId: string },
  actor: ActorContext,
) {
  try {
    // As `imports_read` serializes it: tool results are JSON, and a read's
    // unset optional fields are absent rather than `undefined`.
    const read = mailReadOut.parse(
      JSON.parse(mailReadAgentText(await readMail(db, ref, actor))),
    );
    return { read, readError: null };
  } catch (error) {
    // SILENT: the claim still names the Email; the coordinator resolves it from the read's refusal.
    if (error instanceof AppError)
      return { read: null, readError: error.message };
    throw error;
  }
}

export async function claimMailImportWork(db: Database, runId: string) {
  const id = runEntityId.parse(runId);
  const [current] = await getDb(db)
    .select({
      shortcode: runTable.shortcode,
      status: runTable.status,
      trigger: runTable.trigger,
      actorUserId: runTable.actorUserId,
    })
    .from(runTable)
    .where(eq(runTable.id, id))
    .limit(1);
  if (!current) throw new Error("Mail import Run was not found");
  if (current.status !== "running") return { kind: "none" as const };
  const actor = buildActorContext(current.actorUserId, "system", {
    runId: id,
  });
  const pending = (await readMailRunSources(getDb(db), id)).filter(
    (source) =>
      source.owned && source.unchanged && source.email.status === "researching",
  );
  for (const [index, source] of pending.entries()) {
    if (await settleByRule(db, source, actor, current.trigger === "foreground"))
      continue;
    const { email } = source;
    const ref = { mailboxId: email.mailboxId, messageId: email.messageId };
    return {
      kind: "email" as const,
      runId: current.shortcode,
      remaining: pending.length - index,
      email: {
        ...ref,
        sender: email.sender,
        subject: email.subject,
        receivedAt: email.receivedAt?.toISOString() ?? null,
      },
      ...(await claimedRead(db, ref, actor)),
    };
  }
  return { kind: "none" as const };
}

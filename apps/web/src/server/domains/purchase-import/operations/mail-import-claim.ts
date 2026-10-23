/**
 * Pi's next admitted Email (`claim_next_import_work`), with its compact read.
 * Each Email stays the current item until `purchase_import.mail_resolve` or a mail-sourced
 * commit settles its target. Leading Emails a Mail import rule decides
 * (`service/mail-import-rule.ts`) are settled first, through `purchase_import.mail_resolve`'s
 * own writer, so the coordinator never spends a turn on them.
 *
 * Rules run inside the claim, not at admission or in the coordinator: the
 * claim is a leased Run operation whose replay returns its recorded result,
 * and each rule outcome is its own `purchase_import.mail_resolve` transaction, idempotent by
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

/** Most order-id Purchases a claim lists; more means the id is not specific. */
const KNOWN_PURCHASES_MAX = 5;

/**
 * What Cubby already established for the claimed Email, so the coordinator
 * does not spend model calls on the Vendor and Purchase lookups most Emails
 * otherwise start with: the Vendor its sender proves, the order identifiers
 * it prints, and the live Purchases holding one of those order ids.
 */
type KnownForEmail = {
  senderVendor: { id: string; name: string } | null;
  orderIds: string[];
  purchases: Array<{
    id: string;
    orderId: string;
    vendorId: string;
    date: string | null;
    imported: boolean;
  }>;
};

/**
 * `settled` when a rule settled the Email; otherwise it goes to the
 * coordinator with what the rule's evidence established (null when the
 * retained copy is gone or changed).
 */
async function settleByRule(
  db: Database,
  source: MailRunSource,
  actor: ActorContext,
  memberSelected: boolean,
): Promise<"settled" | { known: KnownForEmail | null }> {
  const [mail] = await readRetainedMail(db, {
    ledgerPartyIds: [source.email.ledgerPartyId],
    orderMailIds: [source.orderMailId],
  });
  if (!mail || mail.rawChecksum !== source.checksum) return { known: null };
  const content = mailReadContent(mail.content, {});
  const text = [content.preheader, content.bodyText].filter(Boolean).join("\n");
  const proof = await senderProofVendor(db, mail.sender);
  const orderIds = orderIdentifiers(mail.subject, text);
  const candidates = await readMailRuleCandidates(db, {
    ledgerPartyId: mail.ledgerPartyId,
    orderIds,
  });
  const known: KnownForEmail = {
    senderVendor: proof
      ? { id: proof.vendor.shortcode, name: proof.vendor.name }
      : null,
    orderIds,
    purchases: candidates.slice(0, KNOWN_PURCHASES_MAX).map((candidate) => ({
      id: candidate.purchaseId,
      orderId: candidate.orderId,
      vendorId: candidate.vendorShortcode,
      date: candidate.date,
      imported: candidate.importedSource,
    })),
  };
  // A later page or omitted evidence may reverse an apparent lifecycle notice.
  // The coordinator can page the read; a deterministic link cannot assume it.
  if (content.truncated || content.nextOffset !== null) return { known };
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
    candidates,
  });
  if (decision.kind === "coordinator") return { known };
  const ref = {
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    checksum: mail.rawChecksum,
  };
  try {
    await resolveMail(
      db,
      {
        ...ref,
        disposition: { kind: "unrelated", reason: decision.reason },
      },
      actor,
      undefined,
      undefined,
      { revision: MAIL_IMPORT_RULE_REVISION },
    );
  } catch (error) {
    // SILENT: a refusal `purchase_import.mail_resolve` would give the coordinator (a member's dismissal, another Purchase's link, changed evidence) hands it the Email instead.
    if (error instanceof AppError) return { known };
    throw error;
  }
  return "settled";
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
    const ruled = await settleByRule(
      db,
      source,
      actor,
      current.trigger === "foreground",
    );
    if (ruled === "settled") continue;
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
      known: ruled.known,
    };
  }
  return { kind: "none" as const };
}

/**
 * Pi's next admitted Email (`claim_next_import_work`), with its compact read.
 * Each Email stays the current item until `purchase_import.mail_resolve` or a mail-sourced
 * commit settles its target. Leading Emails a Mail import rule decides,
 * including exact carrier notices whose package it records first,
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
import { parseShortcodeFor, runEntityId } from "@cubby/schemas/identifiers";
import {
  mailboxClassification,
  mailboxClassificationStage,
  mailReadAgentText,
  mailReadOut,
} from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  purchase as purchaseTable,
  run as runTable,
  shipment as shipmentTable,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { readMailRunSources } from "~/server/domains/purchase-import/repo/mail-run-membership";
import { recordShipmentEvidence } from "~/server/domains/shipment/repo/evidence";
import { AppError } from "~/server/errors/app-error";

import { mailReadContent } from "../repo/gmail/read-content";
import { senderProofVendor } from "../repo/import-vendor";
import {
  countRetainedMailAttachments,
  readMailRuleCandidates,
} from "../repo/mail-rule-evidence";
import {
  carrierNotice,
  decideMailByRule,
  MAIL_IMPORT_RULE_REVISION,
  orderIdentifiers,
  type CarrierNotice,
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
 * Records a carrier notice's package and settles the Email: linked only to the
 * Purchase that exact Shipment already holds, otherwise unresolved naming the
 * gap. False hands it to the coordinator when the writer holds the package.
 */
async function settleCarrierNotice(
  db: Database,
  source: MailRunSource,
  ref: { mailboxId: string; messageId: string; checksum: string },
  notice: CarrierNotice,
  actor: ActorContext,
) {
  const packet = {
    shipmentId: null,
    sourceShipmentKey: null,
    distinctPackageEvidence: null,
    carrierId: null,
    carrierName: notice.carrierName,
    trackingNumber: notice.trackingNumber,
    extraTrackingNumbers: [],
    purpose: "unknown" as const,
    observations: [
      {
        sourceEventKey: null,
        kind: notice.kind,
        time: { kind: "date" as const, value: notice.day },
        timeBasis: notice.timeBasis,
        rawStatus: notice.rawStatus,
        location: null,
        carrierId: null,
        carrierName: notice.carrierName,
        trackingNumber: notice.trackingNumber,
      },
    ],
  };
  const recorded = await recordShipmentEvidence(
    db,
    {
      source: {
        kind: "email",
        emailId: parseShortcodeFor("email", source.email.shortcode),
        checksum: ref.checksum,
      },
      purchaseId: null,
      shipments: [packet],
    },
    actor,
  );
  const [shipmentCode] = recorded.shipmentIds;
  if (
    recorded.unresolvedPackages?.length ||
    recorded.shipmentIds.length !== 1 ||
    !shipmentCode
  )
    return false;
  const [held] = await getDb(db)
    .select({ purchaseCode: purchaseTable.shortcode })
    .from(shipmentTable)
    .leftJoin(purchaseTable, eq(purchaseTable.id, shipmentTable.purchaseId))
    .where(eq(shipmentTable.shortcode, shipmentCode))
    .limit(1);
  await resolveMail(
    db,
    {
      ...ref,
      disposition: held?.purchaseCode
        ? {
            kind: "linked",
            purchaseIds: [parseShortcodeFor("purchase", held.purchaseCode)],
            event: "shipped",
          }
        : {
            kind: "unresolved",
            reason: `Package retained as ${shipmentCode}; this ${notice.carrierName} notice names no order or Purchase.`,
          },
    },
    actor,
    undefined,
    undefined,
    { revision: MAIL_IMPORT_RULE_REVISION },
  );
  return true;
}

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
    carrierNotice: carrierNotice({
      sender: mail.sender,
      subject: mail.subject,
      text,
      notificationDay: mail.receivedAt
        ? householdLocalDate(mail.receivedAt)
        : null,
    }),
  });
  if (decision.kind === "coordinator") return { known };
  const ref = {
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    checksum: mail.rawChecksum,
  };
  try {
    if (decision.kind === "package_notice")
      return (await settleCarrierNotice(
        db,
        source,
        ref,
        decision.notice,
        actor,
      ))
        ? "settled"
        : { known };
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
        checksum: email.checksum,
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

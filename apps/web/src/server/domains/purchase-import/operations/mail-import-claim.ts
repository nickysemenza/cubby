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
import {
  parseShortcodeFor,
  runEntityId,
  type ShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  mailboxClassification,
  mailboxClassificationStage,
  mailReadAgentText,
  mailReadOut,
} from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, isNull, sql } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import {
  purchase as purchaseTable,
  run as runTable,
  shipment as shipmentTable,
  shipmentObservation,
  shipmentSourceCapture,
  vendorAccount,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { readMailAttemptRecovery } from "~/server/domains/purchase-import/repo/mail-attempts";
import { readMailRunSources } from "~/server/domains/purchase-import/repo/mail-run-membership";
import { recordShipmentEvidence } from "~/server/domains/shipment/repo/evidence";
import { AppError } from "~/server/errors/app-error";

import {
  EXISTING_ORDER_CANDIDATES_MAX,
  readExistingOrderCandidates,
  type ExistingOrderCandidate,
} from "../repo/existing-order-candidates";
import { mailReadContent } from "../repo/gmail/read-content";
import { senderProofVendor } from "../repo/import-vendor";
import {
  countRetainedMailAttachments,
  hasUnrecognisedTracking,
  readEmailMailKeys,
  readMailRuleCandidates,
  readMailProductCandidates,
  type MailKeys,
  type MailProductEvidence,
  type MailRuleCandidate,
} from "../repo/mail-rule-evidence";
import { createNoticePurchase } from "../repo/notice-purchase";
import {
  carrierNotice,
  decideMailByRule,
  mailLifecycleEvent,
  MAIL_IMPORT_RULE_REVISION,
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
 * it prints, the live Purchases holding one of those order ids, and
 * `existingOrders`: Purchases from this Email's thread or an unitemized
 * statement booking that may be the same order. An existing order is the
 * prepare target, never a second Purchase.
 */
type KnownForEmail = {
  products: MailProductEvidence;
  senderVendor: { id: string; name: string } | null;
  orderIds: string[];
  purchases: Array<{
    id: string;
    orderId: string;
    vendorId: string;
    date: string | null;
    imported: boolean;
  }>;
  existingOrders: ExistingOrderCandidate[];
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
            category: "missing_evidence",
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

const OBSERVED_KIND = {
  confirmation: "unknown",
  shipped: "vendor_shipped",
  delivered: "delivered",
} as const;

/**
 * Model-free exact linking of a lifecycle notice to the one Purchase its
 * evidence names: (a) a Shipment this Email already sourced, (b) a tracking
 * key equal to exactly one Shipment, (c) the sender-proven Vendor's order key
 * equal to exactly one live Purchase. Every rule that applies must name the
 * same Purchase, on the Email owner's own account; anything else is the
 * coordinator's, including any candidate on another account. Association
 * alone cannot establish that package evidence was extracted (#3013), so
 * (b)/(c) record the Email's one recognised package through the linked
 * disposition's shipment evidence; a shipping or delivery notice without
 * recognised tracking, with several packages or with any unrecognised
 * tracking reference goes to the coordinator. A confirmation links only to a
 * Purchase an import already sourced, so no lines are lost. A shipping or
 * delivery notice whose sender-proven Vendor prints one order number that no
 * live Purchase holds creates that order's empty Purchase and links to it in
 * one transaction (`createNoticePurchase`); the confirmation later itemizes it.
 */
async function linkByExactEvidence(
  db: Database,
  input: {
    source: MailRunSource;
    ref: { mailboxId: string; messageId: string; checksum: string };
    subject: string | null;
    text: string;
    receivedAt: Date | null;
    links: readonly string[];
    keys: MailKeys;
    senderVendorId: VendorId | null;
    candidates: readonly MailRuleCandidate[];
    actor: ActorContext;
  },
) {
  const event = mailLifecycleEvent(input.subject, input.text);
  if (!event) return false;
  // The link records package evidence only for references Cubby recognised.
  // An unknown carrier, an unrecognised tracking reference, or more than one
  // package (whose individual states the subject cannot prove) needs the
  // coordinator's extraction.
  const tracking = input.keys.trackingKeys;
  if (
    tracking.length > 1 ||
    tracking.some((key) => key.carrier === null) ||
    hasUnrecognisedTracking({
      text: `${input.subject ?? ""}\n${input.text}`,
      links: input.links,
      keys: tracking,
    })
  )
    return false;
  const { email } = input.source;
  const ownPurchase = and(
    notDeleted(purchaseTable),
    eq(vendorAccount.vendorId, purchaseTable.vendorId),
    eq(vendorAccount.ledgerPartyId, email.ledgerPartyId),
    notDeleted(vendorAccount),
  );
  const shipmentPurchase = {
    shipmentId: shipmentTable.id,
    purchaseId: purchaseTable.shortcode,
    vendorId: purchaseTable.vendorId,
    own: sql<boolean>`${vendorAccount.id} IS NOT NULL`,
  };
  const sourced = await getDb(db)
    .selectDistinct(shipmentPurchase)
    .from(shipmentObservation)
    .innerJoin(
      shipmentSourceCapture,
      eq(shipmentSourceCapture.id, shipmentObservation.sourceCaptureId),
    )
    .innerJoin(
      shipmentTable,
      eq(shipmentTable.id, shipmentObservation.shipmentId),
    )
    .leftJoin(purchaseTable, eq(purchaseTable.id, shipmentTable.purchaseId))
    .leftJoin(
      vendorAccount,
      and(eq(vendorAccount.id, purchaseTable.vendorAccountId), ownPurchase),
    )
    .where(
      and(
        eq(shipmentSourceCapture.emailId, email.id),
        eq(shipmentSourceCapture.checksum, input.ref.checksum),
        isNull(shipmentObservation.supersededById),
        notDeleted(shipmentTable),
      ),
    );
  const numbers = input.keys.trackingKeys.map((key) => key.number);
  const tracked = numbers.length
    ? await getDb(db)
        .selectDistinct(shipmentPurchase)
        .from(shipmentTable)
        .leftJoin(purchaseTable, eq(purchaseTable.id, shipmentTable.purchaseId))
        .leftJoin(
          vendorAccount,
          and(eq(vendorAccount.id, purchaseTable.vendorAccountId), ownPurchase),
        )
        .where(
          and(
            notDeleted(shipmentTable),
            sql`(upper(regexp_replace(${shipmentTable.trackingNumber}, '[[:space:]]', '', 'g')) IN (${sql.join(
              numbers.map((number) => sql`${number}`),
              sql`, `,
            )}) OR EXISTS (SELECT 1 FROM jsonb_array_elements(${shipmentTable.extraTrackingNumbers}) ref
              WHERE upper(regexp_replace(ref->>'trackingNumber', '[[:space:]]', '', 'g')) IN (${sql.join(
                numbers.map((number) => sql`${number}`),
                sql`, `,
              )})))`,
          ),
        )
    : [];
  const proposals: {
    purchaseId: string | null;
    vendorId: VendorId | null;
    rule: "sourced" | "tracked" | "ordered";
  }[] = [];
  // A Shipment held by another member's or a deleted Purchase contradicts any
  // link; a Shipment no Purchase holds yet names nothing.
  if (
    [...sourced, ...tracked].some((row) => row.purchaseId !== null && !row.own)
  )
    return false;
  // (a) names one Purchase; (b) names one Shipment.
  const sourcedPurchases = [
    ...new Map(
      sourced.flatMap((row) =>
        row.purchaseId ? [[row.purchaseId, row] as const] : [],
      ),
    ).values(),
  ];
  if (sourcedPurchases.length > 1) return false;
  if (sourcedPurchases[0])
    proposals.push({ ...sourcedPurchases[0], rule: "sourced" });
  const trackedHeld = tracked.filter((row) => row.purchaseId !== null);
  if (tracked.length > 1 && trackedHeld.length > 0) return false;
  if (trackedHeld[0]) proposals.push({ ...trackedHeld[0], rule: "tracked" });
  // (c) Every Purchase the order key names counts, on any account: another
  // member's equal order is a contradiction, never a filtered-out candidate.
  if (input.candidates.length) {
    const [only, ...others] = input.candidates;
    if (
      !only ||
      others.length ||
      !only.ownAccount ||
      only.vendorId !== input.senderVendorId ||
      (event === "confirmation" && !only.importedSource)
    )
      return false;
    proposals.push({
      purchaseId: only.purchaseId,
      vendorId: only.vendorId,
      rule: "ordered",
    });
  }
  const day = input.receivedAt ? householdLocalDate(input.receivedAt) : null;
  const [orderKey, ...otherOrderKeys] = input.keys.orderKeys;
  if (
    !proposals.length &&
    !input.candidates.length &&
    event !== "confirmation" &&
    input.senderVendorId &&
    orderKey &&
    !otherOrderKeys.length &&
    numbers.length === 1 &&
    day
  )
    return linkNoticePurchase(db, {
      ...input,
      event,
      senderVendorId: input.senderVendorId,
      orderKey,
      day,
    });
  const purchaseIds = new Set(proposals.map((item) => item.purchaseId));
  const [purchaseCode] = purchaseIds;
  if (purchaseIds.size !== 1 || !purchaseCode) return false;
  // A sender proven to be another Vendor contradicts the Shipment's Purchase.
  if (
    input.senderVendorId &&
    proposals.some((item) => item.vendorId !== input.senderVendorId)
  )
    return false;
  const sourcedOnly = proposals.every((item) => item.rule === "sourced");
  if (!sourcedOnly && event !== "confirmation" && !numbers.length) return false;
  if (!sourcedOnly && numbers.length && !day) return false;
  const purchaseId = parseShortcodeFor("purchase", purchaseCode);
  const shipments =
    !sourcedOnly && numbers.length && day
      ? noticeShipments({ ...input, event, purchaseId, day })
      : undefined;
  try {
    await resolveMail(
      db,
      {
        ...input.ref,
        disposition: {
          kind: "linked",
          purchaseIds: [purchaseId],
          event,
          ...(shipments ? { shipments } : {}),
        },
      },
      input.actor,
      undefined,
      undefined,
      { revision: MAIL_IMPORT_RULE_REVISION },
    );
  } catch (error) {
    // SILENT: a refusal (a member's dismissal, a controlled Vendor, changed evidence) leaves the Email to the coordinator.
    if (error instanceof AppError) return false;
    throw error;
  }
  return true;
}

/** The notice's one recognised package, recorded through its linked disposition. */
function noticeShipments(input: {
  purchaseId: ShortcodeFor<"purchase">;
  keys: MailKeys;
  event: keyof typeof OBSERVED_KIND;
  subject: string | null;
  day: string;
}) {
  return [
    {
      purchaseId: input.purchaseId,
      shipments: input.keys.trackingKeys.map((key) => ({
        shipmentId: null,
        sourceShipmentKey: null,
        distinctPackageEvidence: null,
        carrierId: null,
        carrierName: key.carrier,
        trackingNumber: key.number,
        extraTrackingNumbers: [],
        purpose: "unknown" as const,
        observations: [
          {
            sourceEventKey: null,
            kind: OBSERVED_KIND[input.event],
            time: { kind: "date" as const, value: input.day },
            timeBasis: "notification_received" as const,
            rawStatus: input.subject ?? input.event,
            location: null,
            carrierId: null,
            carrierName: key.carrier,
            trackingNumber: key.number,
          },
        ],
      })),
    },
  ];
}

/**
 * A shipping or delivery notice that arrives before its order: create the
 * empty Purchase its order number names and link the notice and its package
 * to it in one transaction, so a refused link leaves no Purchase behind.
 */
async function linkNoticePurchase(
  db: Database,
  input: {
    source: MailRunSource;
    ref: { mailboxId: string; messageId: string; checksum: string };
    subject: string | null;
    keys: MailKeys;
    senderVendorId: VendorId;
    orderKey: string;
    day: string;
    event: Exclude<keyof typeof OBSERVED_KIND, "confirmation">;
    actor: ActorContext;
  },
) {
  try {
    return await withTransaction(db, async (tx) => {
      const purchaseCode = await createNoticePurchase(tx, {
        ledgerPartyId: input.source.email.ledgerPartyId,
        vendorId: input.senderVendorId,
        orderKey: input.orderKey,
        day: input.day,
        actor: input.actor,
      });
      if (!purchaseCode) return false;
      const purchaseId = parseShortcodeFor("purchase", purchaseCode);
      await resolveMail(
        databaseForTransaction(tx),
        {
          ...input.ref,
          disposition: {
            kind: "linked",
            purchaseIds: [purchaseId],
            event: input.event,
            shipments: noticeShipments({ ...input, purchaseId }),
          },
        },
        input.actor,
        undefined,
        undefined,
        { revision: MAIL_IMPORT_RULE_REVISION },
      );
      return true;
    });
  } catch (error) {
    // SILENT: a refused link rolls back the empty Purchase and leaves the Email to the coordinator.
    if (error instanceof AppError) return false;
    throw error;
  }
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
): Promise<
  "settled" | { known: KnownForEmail | null; attemptContext?: string }
> {
  const [mail] = await readRetainedMail(db, {
    ledgerPartyIds: [source.email.ledgerPartyId],
    orderMailIds: [source.orderMailId],
  });
  if (!mail || mail.rawChecksum !== source.checksum) return { known: null };
  const content = mailReadContent(mail.content, {});
  const text = [content.preheader, content.bodyText].filter(Boolean).join("\n");
  const proof = await senderProofVendor(db, mail.sender);
  const keys = await readEmailMailKeys(db, mail);
  // Order numbers repeat across Vendors; only the sender-proven Vendor's count.
  const candidates = proof
    ? await readMailRuleCandidates(db, {
        ledgerPartyId: mail.ledgerPartyId,
        vendorId: proof.vendor.id,
        orderKeys: keys.orderKeys,
      })
    : [];
  const existingOrders = proof
    ? await readExistingOrderCandidates(
        db,
        {
          ledgerPartyId: mail.ledgerPartyId,
          vendorId: proof.vendor.id,
          mailboxId: mail.mailboxId,
          messageId: mail.messageId,
          threadId: mail.threadId,
          receivedAt: mail.receivedAt,
        },
        { limit: EXISTING_ORDER_CANDIDATES_MAX },
      )
    : [];
  const known: Omit<KnownForEmail, "products"> = {
    senderVendor: proof
      ? { id: proof.vendor.shortcode, name: proof.vendor.name }
      : null,
    orderIds: keys.orderKeys,
    purchases: candidates.slice(0, KNOWN_PURCHASES_MAX).map((candidate) => ({
      id: candidate.purchaseId,
      orderId: candidate.orderId,
      vendorId: candidate.vendorShortcode,
      date: candidate.date,
      imported: candidate.importedSource,
    })),
    existingOrders,
  };
  const attemptContext = JSON.stringify([
    ...candidates
      .map((candidate) => [
        candidate.purchaseId,
        candidate.acceptedSourceFingerprint,
      ])
      .sort(),
    ...existingOrders.map((candidate) => [candidate.basis, candidate.id]),
  ]);
  const knownForCoordinator = async (): Promise<KnownForEmail> => ({
    ...known,
    products: await readMailProductCandidates(db, {
      ledgerPartyId: mail.ledgerPartyId,
      vendorId: proof?.vendor.id ?? null,
      purchaseIds: candidates
        .filter(
          (candidate) =>
            candidate.ownAccount && candidate.vendorId === proof?.vendor.id,
        )
        .slice(0, KNOWN_PURCHASES_MAX)
        .map((candidate) => candidate.purchaseId),
      links: content.links,
    }),
  });
  // A later page or omitted evidence may reverse an apparent lifecycle notice.
  // The coordinator can page the read; a deterministic link cannot assume it.
  if (content.truncated || content.nextOffset !== null)
    return {
      known: await knownForCoordinator(),
      attemptContext,
    };
  const retainedAttachments = await countRetainedMailAttachments(db, mail.id);
  const ref = {
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    checksum: mail.rawChecksum,
  };
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
    retainedAttachments,
    candidates,
    orderKeys: keys.orderKeys,
    carrierNotice: carrierNotice({
      sender: mail.sender,
      subject: mail.subject,
      text,
      notificationDay: mail.receivedAt
        ? householdLocalDate(mail.receivedAt)
        : null,
    }),
  });
  if (decision.kind === "coordinator") {
    // Before spending a coordinator, an exact and unambiguous link settles a
    // lifecycle notice of a Purchase Cubby already holds.
    if (
      retainedAttachments === 0 &&
      source.email.classification === "related" &&
      (await linkByExactEvidence(db, {
        source,
        ref,
        subject: mail.subject,
        text,
        receivedAt: mail.receivedAt,
        links: content.links.map((link) => link.href),
        keys,
        senderVendorId: proof?.vendor.id ?? null,
        candidates,
        actor,
      }))
    )
      return "settled";
    return {
      known: await knownForCoordinator(),
      attemptContext,
    };
  }
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
        : { known: await knownForCoordinator(), attemptContext };
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
    if (error instanceof AppError)
      return {
        known: await knownForCoordinator(),
        attemptContext,
      };
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
    const evidenceVersion = await sha256Hex(
      JSON.stringify({
        checksum: email.checksum,
        senderVendorId: ruled.known?.senderVendor?.id ?? null,
        orderIds: ruled.known?.orderIds ?? [],
        acceptedSources: ruled.attemptContext,
      }),
    );
    const recovery = await readMailAttemptRecovery(db, {
      ledgerPartyId: email.ledgerPartyId,
      orderMailId: source.orderMailId,
      runId: id,
      source: { ...ref, checksum: email.checksum, evidenceVersion },
    });
    return {
      kind: "email" as const,
      evidenceVersion,
      ...(recovery ? { recovery } : {}),
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

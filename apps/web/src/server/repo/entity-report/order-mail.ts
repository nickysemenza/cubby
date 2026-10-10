import type { ActorContext } from "@cubby/schemas/context";
import type {
  ReportBlock,
  ReportCommand,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { vendorShortcode } from "@cubby/schemas/identifiers";
import type { VendorOrderMailOut } from "@cubby/schemas/order-mail-review";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { vendor, vendorAccount } from "~/server/db/schema";
import {
  listPurchaseOrderMail,
  listVendorOrderMail,
} from "~/server/purchase-import/gmail/review";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

type Mail = VendorOrderMailOut["items"][number];
type Event = Mail["events"][number];
type Candidate = Event["candidates"][number];

const decisionCommand = (
  event: Event,
  candidate: Candidate | null,
): ReportCommand => {
  const command: ReportCommand = {
    id: `decide:${event.id}:${candidate?.purchaseId ?? "select"}`,
    label: candidate?.decision === "linked" ? "Dismiss link" : "Link Purchase",
    prominent: false,
    confirm:
      "Apply this reviewed email relationship? This does not change spending or inventory.",
    request: {
      kind: "decide-order-mail",
      eventId: event.id,
      evidenceChecksum: event.evidenceChecksum,
      purchaseId: candidate?.purchaseId ?? null,
      decision: candidate?.decision === "linked" ? "dismissed" : "linked",
    },
  };
  if (!candidate)
    command.inputs = [
      {
        kind: "record",
        key: "purchaseId",
        label: "Purchase",
        entity: "purchase",
      },
    ];
  return command;
};

const candidateStatus = (
  candidate: Candidate | null,
): NonNullable<ReportRecordRow["statuses"]>[number] => {
  if (!candidate) return { label: "Unlinked" };
  if (candidate.decision === "linked") return { label: "Linked" };
  if (candidate.decision === "dismissed")
    return { label: "Dismissed", tone: "muted" };
  return { label: "Suggested match" };
};

const changedDecision = (
  event: Event,
  candidate: Candidate | null,
): NonNullable<ReportRecordRow["lines"]> =>
  candidate?.evidenceChecksum &&
  candidate.evidenceChecksum !== event.evidenceChecksum
    ? [
        {
          text: "Original changed since this decision; the earlier decision is retained.",
          tone: "warning",
        },
      ]
    : [];

const decisionCommands = (
  event: Event,
  candidate: Candidate | null,
  canDecide: boolean,
): ReportCommand[] => {
  if (!canDecide) return [];
  const link = decisionCommand(event, candidate);
  if (!candidate || candidate.decision !== null) return [link];
  return [
    link,
    {
      ...link,
      id: `${link.id}:dismiss`,
      label: "Dismiss suggestion",
      request: {
        kind: "decide-order-mail",
        eventId: event.id,
        purchaseId: candidate.purchaseId,
        evidenceChecksum: event.evidenceChecksum,
        decision: "dismissed",
      },
    },
  ];
};

const eventRows = (mail: Mail, canDecide: boolean): ReportRecordRow[] =>
  mail.events.flatMap((event) =>
    (event.candidates.length ? event.candidates : [null]).map((candidate) => ({
      entity: candidate ? "purchase" : null,
      id: candidate?.purchaseId ?? null,
      key: `${event.id}:${candidate?.purchaseId ?? "unlinked"}`,
      title: `${event.event} · ${event.orderId ?? "Order identity not printed"}`,
      subtitle: candidate
        ? `Purchase ${candidate.purchaseId}`
        : "No reviewed Purchase link",
      trailing:
        event.amount === null
          ? null
          : `${event.amount}${event.currency ? ` ${event.currency}` : ""}`,
      statuses: [candidateStatus(candidate)],
      at: candidate?.decisionUpdatedAt ?? undefined,
      lines: changedDecision(event, candidate),
      detail: {
        label: "Source and decision",
        text: JSON.stringify(
          {
            eventId: event.id,
            currentChecksum: event.evidenceChecksum,
            reviewedChecksum: candidate?.evidenceChecksum ?? null,
            candidateReason: candidate?.reason ?? null,
          },
          null,
          2,
        ),
      },
      commands: decisionCommands(event, candidate, canDecide),
    })),
  );

const mailRows = (
  mail: Mail,
  memberId: string | undefined,
): ReportRecordRow[] => {
  const canDecide = memberId === mail.ledgerPartyId;
  const event = mail.events[0];
  const original: ReportRecordRow = {
    entity: null,
    id: null,
    key: `${mail.ledgerPartyId}:${mail.messageId}`,
    title: mail.subject || "Original email",
    subtitle: `${mail.sender} · ${mail.ledgerPartyId}`,
    trailing: mail.receivedAt ? null : "Unknown date",
    externalLink: {
      label: "Open Gmail original",
      url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.threadId ?? mail.messageId)}`,
    },
    statuses: mail.processing
      ? [
          { label: `Classification: ${mail.processing.classification}` },
          { label: `Processing: ${mail.processing.status}` },
        ]
      : [{ label: "Processing history unavailable", tone: "muted" }],
    lines: mail.processing
      ? [{ text: `Processing updated: ${mail.processing.updatedAt}` }]
      : [],
    detail: {
      label: "Original source",
      text: JSON.stringify(
        {
          messageId: mail.messageId,
          threadId: mail.threadId,
          member: mail.ledgerPartyId,
          associations: mail.associations,
          processing: mail.processing,
        },
        null,
        2,
      ),
    },
    commands:
      canDecide && event
        ? [
            {
              id: `research:${event.id}`,
              label: "Research original",
              prominent: false,
              confirm: null,
              request: {
                kind: "research-order-mail",
                eventId: event.id,
                evidenceChecksum: event.evidenceChecksum,
              },
            },
          ]
        : [],
  };
  if (mail.receivedAt) original.at = mail.receivedAt;
  const research = mail.researchRun;
  const researchRows: ReportRecordRow[] = research
    ? [
        {
          entity: "run",
          id: research.id,
          title: `Research ${research.id}`,
          subtitle: `Run ${research.status} · source ${research.sourceStatus}`,
          trailing: null,
          at: research.endedAt ?? research.startedAt ?? undefined,
          detail: {
            label: "Research source",
            text: `Evidence checksum: ${research.evidenceChecksum}`,
          },
        },
      ]
    : [];
  const associations: ReportRecordRow[] = mail.associations.map(
    (association) => ({
      entity: "purchase",
      id: association.purchaseId,
      key: `accepted:${mail.messageId}:${association.purchaseId}`,
      title: `Purchase ${association.purchaseId}`,
      subtitle: "Accepted email source",
      trailing: null,
      at: association.acceptedAt,
      statuses: [{ label: "Accepted source" }],
      lines:
        association.evidenceChecksum !== mail.events[0]?.evidenceChecksum &&
        mail.events.length > 0
          ? [
              {
                text: "Original changed since acceptance; the earlier source link is retained.",
                tone: "warning",
              },
            ]
          : [],
      detail: {
        label: "Accepted source",
        text: `Evidence checksum: ${association.evidenceChecksum}`,
      },
    }),
  );
  return [
    original,
    ...associations,
    ...researchRows,
    ...eventRows(mail, canDecide),
  ];
};

const composeMailReport = async (
  db: Database,
  mail: VendorOrderMailOut,
  actor: ActorContext,
  vendorId?: string,
): Promise<ReportBlock[]> => {
  const member = await currentMemberLedgerParty(db, actor);
  return [
    {
      kind: "note",
      text: `Showing ${mail.items.length} retained order emails associated with this record. Processing, accepted source links and reviewed event links are separate states; none establishes Product verification or mailbox-wide coverage.`,
    },
    {
      kind: "records",
      rows: mail.items.flatMap((item) => mailRows(item, member?.shortcode)),
      empty: "No retained email evidence is associated with this record.",
      commands: vendorId
        ? [
            {
              id: "research-purchases",
              label: "Research purchases",
              prominent: true,
              confirm: null,
              request: {
                kind: "research-vendor-purchases",
                vendorId: vendorShortcode.parse(vendorId),
              },
            },
          ]
        : [],
    },
  ];
};

export const vendorOrderMailReport = async (
  db: Database,
  id: string,
  actor: ActorContext,
) =>
  composeMailReport(
    db,
    await listVendorOrderMail(db, { vendorId: id }),
    actor,
    id,
  );

export const purchaseOrderMailReport = async (
  db: Database,
  id: string,
  actor: ActorContext,
) =>
  composeMailReport(
    db,
    await listPurchaseOrderMail(db, { purchaseId: id }),
    actor,
  );

export async function vendorAccountOrderMailReport(
  db: Database,
  id: string,
  actor: ActorContext,
) {
  const accountId = await resolveOrThrow(db, "vendorAccount", id);
  const [account] = await getDb(db)
    .select({
      vendorId: vendor.shortcode,
      ledgerPartyId: vendorAccount.ledgerPartyId,
    })
    .from(vendorAccount)
    .innerJoin(vendor, eq(vendor.id, vendorAccount.vendorId))
    .where(and(eq(vendorAccount.id, accountId), notDeleted(vendorAccount)))
    .limit(1);
  if (!account) throw new Error("Vendor account no longer exists");
  return composeMailReport(
    db,
    await listVendorOrderMail(db, account),
    actor,
    account.vendorId,
  );
}

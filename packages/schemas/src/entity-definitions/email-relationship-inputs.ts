import type { DerivedStoredInput } from "./definition";

/** Inputs of canonical candidate discovery, retained evidence and review precedence. */
export const EMAIL_RELATIONSHIP_INPUTS: DerivedStoredInput[] = [
  {
    table: "Email",
    match: { id: "id" },
    columns: [
      "orderMailId",
      "ledgerPartyId",
      "provider",
      "mailboxId",
      "messageId",
      "receivedAt",
      "checksum",
      "deletedAt",
    ],
  },
  {
    table: "OrderMail",
    match: { id: "orderMailId" },
    columns: ["ledgerPartyId", "vendorId", "rawChecksum"],
  },
  {
    table: "OrderMailEvent",
    match: { orderMailId: "orderMailId" },
    columns: ["orderMailId", "orderId", "amount", "supersededAt"],
  },
  {
    table: "OrderMailAttachment",
    match: { orderMailId: "orderMailId" },
    columns: ["orderMailId", "providerAttachmentId", "checksum"],
  },
  {
    table: "AssessmentState",
    match: { data: "id" },
    json: { key: "eventId" },
    where: { family: "email_link" },
    columns: ["data", "active", "family"],
    path: [
      { table: "OrderMailEvent", from: "id", to: "orderMailId" },
      { table: "Email", from: "orderMailId", to: "id" },
    ],
  },
  // Existing pairs cannot discover every new match after a candidate or source
  // identity edit. Conservative fanout runs in the drain, never in the save.
  {
    table: "Purchase",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: [
      "orderId",
      "vendorId",
      "vendorAccountId",
      "statedTotal",
      "date",
      "deletedAt",
    ],
  },
  {
    table: "VendorAccount",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["ledgerPartyId", "deletedAt"],
  },
  {
    table: "ImportSourceClaim",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["canonicalClaimId", "ledgerPartyId", "kind", "externalKey"],
  },
  {
    table: "ImportSourceOrder",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["sourceClaimId", "purchaseId", "checksum"],
  },
];

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
  // Stable Purchase IDs reach current candidates and retained prior facts.
  {
    table: "Purchase",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    selection: {
      key: "purchaseEvidence",
      retained: { array: ["facts"], key: "purchaseId" },
    },
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
    selection: {
      key: "purchaseEvidence",
      path: [{ table: "Purchase", from: "vendorAccountId", to: "id" }],
      retained: { array: ["facts"], key: "purchaseId" },
    },
    columns: ["ledgerPartyId", "deletedAt"],
  },
  {
    table: "ImportSourceClaim",
    // Old source-family keys are not retained in the relationship facts.
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["canonicalClaimId", "ledgerPartyId", "kind", "externalKey"],
  },
  {
    table: "ImportSourceOrder",
    // Existing tickets still contain SourceOrder IDs and expand conservatively.
    capture: false,
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["sourceClaimId", "purchaseId", "checksum"],
  },
  {
    table: "ImportSourceOrder",
    // Capture both Purchase references before reassignment, detach or deletion.
    match: { purchaseId: "id" },
    targetWhere: { deletedAt: null },
    selection: {
      key: "purchaseEvidence",
      retained: { array: ["facts"], key: "purchaseId" },
    },
    columns: ["sourceClaimId", "purchaseId", "checksum"],
  },
];

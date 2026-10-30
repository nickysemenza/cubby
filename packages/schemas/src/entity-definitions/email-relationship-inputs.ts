import type { DerivedStoredInput } from "./definition";

// Canonical families are a root and direct aliases; seeds keep root-owned orders.
const sourceClaimPurchases = [
  {
    table: "ImportSourceClaim",
    from: "id",
    to: "canonicalClaimId",
    recursive: { maxDepth: 1 },
  },
  {
    table: "ImportSourceClaim",
    from: "canonicalClaimId",
    to: "id",
    recursive: { maxDepth: 1 },
  },
  { table: "ImportSourceOrder", from: "sourceClaimId", to: "purchaseId" },
];

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
    // Pending Claim-ID tickets retain their conservative expansion.
    capture: false,
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
  {
    table: "ImportSourceClaim",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    selection: {
      key: "purchaseEvidence",
      path: sourceClaimPurchases,
      retained: { array: ["facts"], key: "purchaseId" },
    },
    columns: ["canonicalClaimId", "ledgerPartyId", "kind", "externalKey"],
  },
  {
    table: "ImportSourceClaim",
    // Old and new parents keep both families reachable after a move or detach.
    match: { canonicalClaimId: "id" },
    targetWhere: { deletedAt: null },
    selection: {
      key: "purchaseEvidence",
      path: sourceClaimPurchases,
      retained: { array: ["facts"], key: "purchaseId" },
    },
    columns: ["canonicalClaimId", "ledgerPartyId", "kind", "externalKey"],
  },
];

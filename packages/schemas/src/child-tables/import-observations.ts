import { defineChildTable } from "../entity-definitions/child-definition.js";

/** Observations are append-only; accepting one never overwrites the first extraction. */
export const importObservationChildren = [
  defineChildTable({
    name: "ProductIdentityObservation",
    exportName: "productIdentityObservation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "scopeKey", kind: "text", notNull: true },
      { key: "userId", kind: "text", notNull: true },
      { key: "payload", kind: "jsonb", notNull: true, type: "KernelJson" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      { module: "@cubby/schemas/kernel/machinery", exports: ["KernelJson"] },
    ],
    indexes: [
      { name: "ProductIdentityObservation_scope_idx", on: ["scopeKey"] },
    ],
  }),
  defineChildTable({
    name: "SourceOrderObservation",
    exportName: "sourceOrderObservation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "sourceClaimId",
        kind: "uuid",
        reference: { table: "importSourceClaim", column: "id" },
      },
      { key: "orderKey", kind: "text", notNull: true },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      {
        key: "emailId",
        kind: "uuid",
        reference: { table: "email", column: "id" },
      },
      {
        key: "sourceKind",
        kind: "text",
        notNull: true,
        default: "browser_order",
      },
      { key: "sourceExternalKey", kind: "text", notNull: true, default: "" },
      { key: "answerHash", kind: "text" },
      {
        key: "purchaseId",
        kind: "uuid",
        type: "PurchaseId",
        reference: { table: "purchase", column: "id" },
      },
      {
        key: "vendorId",
        kind: "uuid",
        notNull: true,
        type: "VendorId",
        reference: { table: "vendor", column: "id" },
      },
      { key: "runId", kind: "uuid", reference: { table: "run", column: "id" } },
      { key: "checksum", kind: "text", notNull: true },
      {
        key: "extraction",
        kind: "jsonb",
        notNull: true,
        type: "ImportExtractionOutcome",
      },
      {
        key: "productBindings",
        kind: "jsonb",
        notNull: true,
        type: "SourceOrderObservationBindings",
      },
      {
        key: "primaryDocumentImageId",
        kind: "uuid",
        reference: { table: "image", column: "id" },
      },
      {
        key: "screenshotImageId",
        kind: "uuid",
        reference: { table: "image", column: "id" },
      },
      { key: "contentFingerprint", kind: "text", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["PurchaseId", "VendorId", "LedgerPartyId"],
      },
      {
        module: "@cubby/schemas/purchase-import",
        exports: ["ImportExtractionOutcome", "SourceOrderObservationBindings"],
      },
    ],
    indexes: [
      {
        // Keyed by subject: re-importing a deleted Purchase's order observes
        // the same content for the new Purchase without rewriting history.
        name: "SourceOrderObservation_content_key",
        unique: true,
        on: [
          "sourceClaimId",
          "orderKey",
          "checksum",
          "contentFingerprint",
          "purchaseId",
        ],
      },
      { name: "SourceOrderObservation_purchase_idx", on: ["purchaseId"] },
      {
        name: "SourceOrderObservation_source_content_key",
        unique: true,
        on: [
          "ledgerPartyId",
          "sourceKind",
          "sourceExternalKey",
          "orderKey",
          "checksum",
          "contentFingerprint",
        ],
        where: "{purchaseId} IS NULL",
      },
      { name: "SourceOrderObservation_order_key_idx", on: ["orderKey"] },
    ],
    checks: [
      {
        name: "SourceOrderObservation_checksum_check",
        sql: "{checksum} ~ '^[a-f0-9]{64}$'",
      },
    ],
  }),
];

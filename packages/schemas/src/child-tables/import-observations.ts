import { defineChildTable } from "../entity-definitions/child-definition.js";

/** Observations are append-only; accepting one never overwrites the first extraction. */
export const importObservationChildren = [
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
        notNull: true,
        reference: { table: "importSourceClaim", column: "id" },
      },
      { key: "orderKey", kind: "text", notNull: true },
      {
        key: "purchaseId",
        kind: "uuid",
        notNull: true,
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
        exports: ["PurchaseId", "VendorId"],
      },
      {
        module: "@cubby/schemas/purchase-import",
        exports: ["ImportExtractionOutcome", "SourceOrderObservationBindings"],
      },
    ],
    indexes: [
      {
        name: "SourceOrderObservation_content_key",
        unique: true,
        on: ["sourceClaimId", "orderKey", "checksum", "contentFingerprint"],
      },
      { name: "SourceOrderObservation_purchase_idx", on: ["purchaseId"] },
    ],
    checks: [
      {
        name: "SourceOrderObservation_checksum_check",
        sql: "{checksum} ~ '^[a-f0-9]{64}$'",
      },
    ],
  }),
];

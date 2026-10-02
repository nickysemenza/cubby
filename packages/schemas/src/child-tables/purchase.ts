import { defineChildTable } from "../entity-definitions/child-definition.js";

export const purchaseChildren = [
  defineChildTable({
    name: "PurchasePaymentEvidence",
    exportName: "purchasePaymentEvidence",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "purchaseId",
        kind: "uuid",
        notNull: true,
        type: "PurchaseId",
        reference: { table: "purchase", column: "id" },
      },
      {
        key: "sourceClaimId",
        kind: "uuid",
        notNull: true,
        reference: { table: "importSourceClaim", column: "id" },
      },
      { key: "amount", kind: "doublePrecision", notNull: true },
      { key: "chargedAt", kind: "timestamp" },
      { key: "cardLastFour", kind: "text" },
      { key: "description", kind: "text" },
      { key: "evidenceIndex", kind: "integer", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["PurchaseId"] }],
    indexes: [
      {
        name: "PurchasePaymentEvidence_source_index_key",
        unique: true,
        on: ["sourceClaimId", "evidenceIndex"],
      },
      { name: "PurchasePaymentEvidence_purchase_idx", on: ["purchaseId"] },
    ],
  }),
];

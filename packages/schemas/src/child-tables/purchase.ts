import { defineChildTable } from "../entity-definitions/child-definition.js";

export const purchaseChildren = [
  defineChildTable({
    name: "ImportSourceProduct",
    exportName: "importSourceProduct",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "sourceOrderId",
        kind: "uuid",
        notNull: true,
        reference: { table: "importSourceOrder", column: "id" },
      },
      { key: "lineIndex", kind: "integer", notNull: true },
      {
        key: "productId",
        kind: "uuid",
        notNull: true,
        type: "ProductId",
        reference: { table: "product", column: "id" },
      },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["ProductId"] }],
    indexes: [
      {
        name: "ImportSourceProduct_sourceOrder_line_key",
        unique: true,
        on: ["sourceOrderId", "lineIndex"],
      },
      { name: "ImportSourceProduct_product_idx", on: ["productId"] },
    ],
    checks: [
      { name: "ImportSourceProduct_lineIndex_check", sql: "{lineIndex} >= 0" },
    ],
    relations: [
      {
        name: "sourceOrder",
        kind: "one",
        table: "importSourceOrder",
        fields: ["sourceOrderId"],
        references: ["id"],
      },
      {
        name: "product",
        kind: "one",
        table: "product",
        fields: ["productId"],
        references: ["id"],
      },
    ],
  }),
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
        name: "PurchasePaymentEvidence_source_purchase_index_key",
        unique: true,
        on: ["sourceClaimId", "purchaseId", "evidenceIndex"],
      },
      { name: "PurchasePaymentEvidence_purchase_idx", on: ["purchaseId"] },
    ],
  }),
];

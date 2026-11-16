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
        // The Expense owns the current Product; productId below is import history.
        key: "expenseId",
        kind: "uuid",
        type: "ExpenseId",
        reference: { table: "expense", column: "id" },
      },
      {
        key: "productId",
        kind: "uuid",
        type: "ProductId",
        reference: { table: "product", column: "id" },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["ProductId", "ExpenseId"],
      },
    ],
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
        type: "PurchaseId",
        reference: { table: "purchase", column: "id" },
      },
      {
        key: "sourceClaimId",
        kind: "uuid",
        reference: { table: "importSourceClaim", column: "id" },
      },
      {
        key: "orderObservationId",
        kind: "uuid",
        reference: { table: "sourceOrderObservation", column: "id" },
      },
      {
        key: "amountMinor",
        kind: "bigint",
        bigintMode: "bigint",
        notNull: true,
      },
      { key: "chargedAt", kind: "timestamp" },
      { key: "cardLastFour", kind: "text" },
      // What the source says paid this line. `stored_value` (gift card or
      // account balance) never settles against a card charge.
      {
        key: "tender",
        kind: "text",
        values: ["card", "stored_value", "unknown"],
        notNull: true,
        default: "unknown",
      },
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
      {
        name: "PurchasePaymentEvidence_observation_index_key",
        unique: true,
        on: ["orderObservationId", "evidenceIndex"],
      },
      // Spending discovery's retained-payment window (charge day, exact
      // cents): its serializable range read locks only that day range.
      {
        name: "PurchasePaymentEvidence_charged_day_amount_idx",
        on: [{ sql: "({chargedAt}::date)" }, "amountMinor"],
      },
    ],
    checks: [
      {
        name: "PurchasePaymentEvidence_amount_minor_range_check",
        sql: "abs({amountMinor}) <= 100000000000000",
      },
      {
        name: "PurchasePaymentEvidence_tender_check",
        sql: "{tender} IN ('card', 'stored_value', 'unknown')",
      },
    ],
  }),
];

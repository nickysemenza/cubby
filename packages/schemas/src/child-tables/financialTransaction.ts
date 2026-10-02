import { defineChildTable } from "../entity-definitions/child-definition.js";

export const financialTransactionChildren = [
  defineChildTable({
    name: "FinancialTransactionAllocation",
    exportName: "financialTransactionAllocation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "transactionId",
        kind: "uuid",
        notNull: true,
        type: "FinancialTransactionId",
        reference: { table: "financialTransaction", column: "id" },
      },
      {
        key: "purchaseId",
        kind: "uuid",
        notNull: true,
        type: "PurchaseId",
        reference: { table: "purchase", column: "id" },
      },
      { key: "amount", kind: "doublePrecision", notNull: true },
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
      { key: "deletedAt", kind: "timestamp" },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["FinancialTransactionId", "PurchaseId"],
      },
    ],
    indexes: [
      // Partial, so unallocating and re-allocating the same pair stays legal — same
      // rule as `purchaseProduct`'s. One live row per (transaction, purchase): two
      // slices of one charge against one order is one slice, and merging two
      // purchases that share a transaction SUMS into this row rather than adding a
      // second (see PURCHASE_MERGE_EDGE_POLICY — `onConflictDoNothing` there would
      // silently destroy money).
      {
        name: "FinancialTransactionAllocation_transactionId_purchaseId_key",
        unique: true,
        on: ["transactionId", "purchaseId"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "FinancialTransactionAllocation_transactionId_idx",
        on: ["transactionId"],
      },
      {
        name: "FinancialTransactionAllocation_purchaseId_idx",
        on: ["purchaseId"],
      },
    ],
    checks: [
      // Same whole-cent and non-zero rules as FinancialTransaction.amount: a
      // zero-dollar allocation says nothing, and unlinking is deleting the row
      // rather than zeroing it.
      //
      // Declarable here only because push emits CHECKs inside CREATE TABLE for a
      // NEW table; it is edits to an EXISTING table's CHECK that push silently
      // ignores. Treat this expression as immutable — changing it later means a
      // hand-applied ALTER plus a pg_constraint re-read.
      {
        name: "FinancialTransactionAllocation_amount_whole_cent_check",
        sql: "{amount} <> 0 AND abs({amount} * 100 - round({amount} * 100)) < 0.0000001",
      },
    ],
    relations: [
      {
        name: "transaction",
        kind: "one",
        table: "financialTransaction",
        fields: ["transactionId"],
        references: ["id"],
      },
      {
        name: "purchase",
        kind: "one",
        table: "purchase",
        fields: ["purchaseId"],
        references: ["id"],
      },
    ],
  }),
];

import { defineChildTable } from "../entity-definitions/child-definition.js";

export const expenseChildren = [
  /** Unitless beneficiary/funder weights. Money remains solely on Expense.cost. */
  defineChildTable({
    name: "ExpenseAttribution",
    exportName: "expenseAttribution",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
        type: "ExpenseAttributionId",
      },
      {
        key: "expenseId",
        kind: "uuid",
        notNull: true,
        type: "ExpenseId",
        reference: { table: "expense", column: "id" },
      },
      { key: "role", kind: "text", notNull: true, type: "ContributionRole" },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      { key: "weight", kind: "bigint", notNull: true },
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
        exports: ["ExpenseAttributionId", "ExpenseId", "LedgerPartyId"],
      },
      { module: "@cubby/schemas/ledger-party", exports: ["ContributionRole"] },
    ],
    indexes: [
      {
        name: "ExpenseAttribution_expenseId_role_ledgerPartyId_key",
        unique: true,
        on: ["expenseId", "role", "ledgerPartyId"],
        where: "{deletedAt} IS NULL AND {ledgerPartyId} IS NOT NULL",
      },
      {
        name: "ExpenseAttribution_expenseId_role_unattributed_key",
        unique: true,
        on: ["expenseId", "role"],
        where: "{deletedAt} IS NULL AND {ledgerPartyId} IS NULL",
      },
      { name: "ExpenseAttribution_expenseId_idx", on: ["expenseId"] },
      { name: "ExpenseAttribution_ledgerPartyId_idx", on: ["ledgerPartyId"] },
    ],
    checks: [
      {
        name: "ExpenseAttribution_role_check",
        sql: "{role} IN ('beneficiary', 'funder')",
      },
      {
        name: "ExpenseAttribution_weight_check",
        sql: "{weight} > 0 AND {weight} <= 9007199254740991",
      },
    ],
    relations: [
      {
        name: "expense",
        kind: "one",
        table: "expense",
        fields: ["expenseId"],
        references: ["id"],
      },
      {
        name: "ledgerParty",
        kind: "one",
        table: "ledgerParty",
        fields: ["ledgerPartyId"],
        references: ["id"],
      },
    ],
  }),
];

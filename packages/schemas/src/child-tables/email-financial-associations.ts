import { defineChildTable } from "../entity-definitions/child-definition.js";

/**
 * A member's reviewed link between an Email's evidence and a settlement
 * transaction. Append-only history: rows keep their original Email,
 * transaction and account UUIDs through every tombstone, so a later delete
 * never rewrites what was reviewed.
 */
export const emailFinancialAssociationChildren = [
  defineChildTable({
    name: "EmailFinancialAssociation",
    exportName: "emailFinancialAssociation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "emailId",
        kind: "uuid",
        notNull: true,
        type: "EmailId",
        reference: { table: "email", column: "id" },
      },
      { key: "evidenceChecksum", kind: "text", notNull: true },
      {
        key: "transactionId",
        kind: "uuid",
        notNull: true,
        type: "FinancialTransactionId",
        reference: { table: "financialTransaction", column: "id" },
      },
      {
        key: "reviewedAccountId",
        kind: "uuid",
        notNull: true,
        type: "FinancialAccountId",
        reference: { table: "financialAccount", column: "id" },
      },
      { key: "sourceAccountLabel", kind: "text", notNull: true },
      { key: "reviewReason", kind: "text", notNull: true },
      {
        key: "decidedByUserId",
        kind: "text",
        notNull: true,
        type: "UserId",
        reference: { table: "user", column: "id" },
      },
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
        exports: [
          "EmailId",
          "FinancialAccountId",
          "FinancialTransactionId",
          "UserId",
        ],
      },
    ],
    indexes: [
      {
        name: "EmailFinancialAssociation_email_evidence_transaction_key",
        unique: true,
        on: ["emailId", "evidenceChecksum", "transactionId"],
      },
      {
        name: "EmailFinancialAssociation_transaction_idx",
        on: ["transactionId"],
      },
    ],
    checks: [
      {
        name: "EmailFinancialAssociation_evidenceChecksum_check",
        sql: "length(btrim({evidenceChecksum})) > 0",
      },
      {
        name: "EmailFinancialAssociation_sourceAccountLabel_check",
        sql: "length(btrim({sourceAccountLabel})) > 0",
      },
      {
        name: "EmailFinancialAssociation_reviewReason_check",
        sql: "length(btrim({reviewReason})) > 0",
      },
    ],
  }),
];

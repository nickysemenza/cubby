import { defineChildTable } from "../entity-definitions/child-definition";

/** Observation-local notes and unresolved legacy judgments never become shared event state. */
export const financialEvidenceChildren = [
  defineChildTable({
    name: "SourceObservationAnnotation",
    exportName: "sourceObservationAnnotation",
    columns: [
      {
        key: "observationId",
        kind: "uuid",
        primaryKey: true,
        type: "SourceTransactionRecordId",
        reference: { table: "sourceTransactionRecord", column: "id" },
      },
      {
        key: "accountId",
        kind: "uuid",
        type: "FinancialAccountId",
        reference: { table: "financialAccount", column: "id" },
      },
      { key: "disposition", kind: "text", notNull: true, default: "open" },
      { key: "dispositionReason", kind: "text" },
      { key: "dispositionNote", kind: "text" },
      {
        key: "supersededByObservationId",
        kind: "uuid",
        type: "SourceTransactionRecordId",
        reference: { table: "sourceTransactionRecord", column: "id" },
      },
      { key: "notes", kind: "text" },
      // Only unattested legacy observations use these retained lifecycle values.
      { key: "current", kind: "boolean", notNull: true, default: true },
      { key: "withdrawnAt", kind: "timestamp" },
      {
        key: "withdrawalImportId",
        kind: "uuid",
        type: "TransactionImportId",
        reference: { table: "transactionImport", column: "id" },
      },
      {
        key: "lastObservedAt",
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
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: [
          "SourceTransactionRecordId",
          "FinancialAccountId",
          "TransactionImportId",
        ],
      },
    ],
    indexes: [
      { name: "SourceObservationAnnotation_account_idx", on: ["accountId"] },
      {
        name: "SourceObservationAnnotation_superseded_idx",
        on: ["supersededByObservationId"],
      },
      {
        name: "SourceObservationAnnotation_withdrawal_idx",
        on: ["withdrawalImportId"],
      },
    ],
    checks: [
      {
        name: "SourceObservationAnnotation_disposition_check",
        sql: "({disposition} = 'open' AND {dispositionReason} IS NULL AND {dispositionNote} IS NULL) OR ({disposition} = 'ignored' AND {dispositionReason} IN ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other') AND {dispositionNote} IS NOT NULL)",
      },
    ],
  }),
  defineChildTable({
    name: "FinancialEvidenceAlias",
    exportName: "financialEvidenceAlias",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "source",
        kind: "text",
        notNull: true,
        reference: {
          table: "externalSource",
          column: "slug",
          onUpdate: "cascade",
        },
      },
      { key: "kind", kind: "text", notNull: true },
      { key: "value", kind: "text", notNull: true },
      {
        key: "observationId",
        kind: "uuid",
        type: "SourceTransactionRecordId",
        reference: { table: "sourceTransactionRecord", column: "id" },
      },
      {
        key: "occurrenceId",
        kind: "uuid",
        type: "SourceOccurrenceId",
        reference: { table: "sourceOccurrence", column: "id" },
      },
      // Historical binding evidence is queryable but can never establish accepted ownership.
      {
        key: "historicalTransactionId",
        kind: "uuid",
        type: "FinancialTransactionId",
        reference: { table: "financialTransaction", column: "id" },
      },
      { key: "provenanceKey", kind: "text", notNull: true },
      { key: "provenance", kind: "jsonb", notNull: true },
      { key: "scopeEvidence", kind: "jsonb", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      { key: "deletedAt", kind: "timestamp" },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: [
          "SourceTransactionRecordId",
          "SourceOccurrenceId",
          "FinancialTransactionId",
        ],
      },
    ],
    indexes: [
      {
        name: "FinancialEvidenceAlias_provenance_key",
        unique: true,
        on: ["provenanceKey"],
      },
      {
        name: "FinancialEvidenceAlias_lookup_idx",
        on: ["source", "kind", "value"],
      },
      { name: "FinancialEvidenceAlias_observation_idx", on: ["observationId"] },
      {
        name: "FinancialEvidenceAlias_observation_kind_key",
        unique: true,
        on: ["observationId", "kind"],
        where:
          "{kind} IN ('externalId', 'legacyExternalId', 'legacyReference', 'chargeKey')",
      },
      { name: "FinancialEvidenceAlias_occurrence_idx", on: ["occurrenceId"] },
      {
        name: "FinancialEvidenceAlias_historical_transaction_idx",
        on: ["historicalTransactionId"],
      },
    ],
  }),
];

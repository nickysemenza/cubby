import { defineChildTable } from "../entity-definitions/child-definition.js";

export const suggestionChildren = [
  /**
   * One row per noticed issue or proposed action. Pending rows come from
   * idempotent evaluators; `decisions` retains every explicit decision and
   * automatic application receipt, so a decided row is never regenerated over.
   */
  defineChildTable({
    name: "Suggestion",
    exportName: "suggestionTable",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "publicationKey", kind: "text", notNull: true },
      { key: "family", kind: "text", notNull: true, type: "SuggestionFamily" },
      {
        key: "subject",
        kind: "jsonb",
        notNull: true,
        type: "SuggestionSubject",
      },
      { key: "judgment", kind: "jsonb", notNull: true },
      { key: "producer", kind: "jsonb", type: "SuggestionProducer" },
      { key: "evidence", kind: "jsonb" },
      {
        key: "decisions",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'[]'::jsonb" },
        type: "SuggestionDecision[]",
      },
      {
        key: "runId",
        kind: "uuid",
        reference: { table: "run", column: "id", onDelete: "set null" },
      },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        reference: { table: "ledgerParty", column: "id" },
      },
      { key: "entity", kind: "text", notNull: true },
      // Null only on an inactive answer for a record not yet saved.
      { key: "recordId", kind: "uuid" },
      { key: "field", kind: "text", notNull: true, default: "" },
      { key: "financeReviewFingerprint", kind: "text" },
      {
        key: "evaluationId",
        kind: "uuid",
        reference: { table: "aiEvaluation", column: "id" },
      },
      { key: "provenance", kind: "jsonb", type: "AiProvenance" },
      {
        key: "acceptanceReceipt",
        kind: "jsonb",
        type: "SuggestionAcceptanceReceipt",
      },
      {
        key: "supersessionReceipt",
        kind: "jsonb",
        type: "SuggestionSupersessionReceipt",
      },
      { key: "currentValue", kind: "jsonb" },
      {
        key: "suggestedValue",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'null'::jsonb" },
      },
      { key: "confidence", kind: "real", notNull: true, default: 0 },
      { key: "runnerUpValue", kind: "jsonb" },
      { key: "runnerUpConfidence", kind: "real" },
      { key: "model", kind: "text", notNull: true, default: "unknown" },
      { key: "kind", kind: "text", notNull: true, default: "addition" },
      {
        key: "status",
        kind: "text",
        notNull: true,
        default: { sql: "'pending'" },
      },
      { key: "correctValue", kind: "jsonb" },
      {
        key: "data",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'{}'::jsonb" },
      },
      { key: "fingerprint", kind: "text" },
      { key: "confirmedValue", kind: "jsonb", type: "SuggestionCorrection" },
      { key: "suppression", kind: "jsonb", type: "SuggestionSuppression" },
      { key: "active", kind: "boolean", notNull: true, default: true },
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
    types: [
      {
        module: "@cubby/schemas/suggestion",
        exports: [
          "SuggestionFamily",
          "SuggestionSubject",
          "SuggestionProducer",
          "SuggestionCorrection",
          "SuggestionSuppression",
          "SuggestionDecision",
        ],
      },
      {
        module: "@cubby/schemas/ai-evaluation",
        exports: [
          "AiProvenance",
          "SuggestionAcceptanceReceipt",
          "SuggestionSupersessionReceipt",
        ],
      },
    ],
    indexes: [
      {
        name: "Suggestion_publication_key",
        unique: true,
        on: ["publicationKey"],
      },
      {
        name: "Suggestion_family_active_idx",
        on: ["family", "active", "status"],
      },
      { name: "Suggestion_run_status_idx", on: ["runId", "status"] },
      {
        name: "Suggestion_active_suppression_idx",
        on: ["entity", "recordId"],
        where: "{active} AND {suppression} IS NOT NULL",
      },
      {
        name: "Suggestion_ledger_party_idx",
        on: ["ledgerPartyId", "family", "status"],
      },
      { name: "Suggestion_evaluation_idx", on: ["evaluationId"] },
      {
        name: "Suggestion_entity_field_status_idx",
        on: ["entity", "field", "status"],
      },
      {
        name: "Suggestion_entity_record_status_idx",
        on: ["entity", "recordId", "status"],
      },
      {
        name: "Suggestion_active_value_status_idx",
        on: ["status", { sql: "md5({suggestedValue} #>> '{}')" }],
        where: "{active}",
      },
      {
        name: "Suggestion_served_other_id_idx",
        on: [{ sql: "md5({subject}->>'otherId')" }],
        where: "({subject}->>'otherId') IS NOT NULL",
      },
      {
        name: "Suggestion_served_source_ref_idx",
        on: [
          { sql: "md5({judgment} #>> '{create,sourceRef,source}')" },
          { sql: "md5({judgment} #>> '{create,sourceRef,externalId}')" },
        ],
        where:
          "({judgment} #>> '{create,sourceRef,source}') IS NOT NULL AND ({judgment} #>> '{create,sourceRef,externalId}') IS NOT NULL",
      },
      {
        name: "Suggestion_reference_records_idx",
        using: "gin",
        on: [{ sql: "({evidence}->'records')" }],
      },
    ],
    checks: [
      {
        name: "Suggestion_kind_check",
        sql: "{kind} IN ('correction', 'addition')",
      },
      {
        name: "Suggestion_status_check",
        sql: "{status} IN ('pending', 'applied', 'rejected', 'superseded', 'resolved')",
      },
      {
        name: "Suggestion_confidence_check",
        sql: "{confidence} BETWEEN 0 AND 1",
      },
    ],
  }),
];

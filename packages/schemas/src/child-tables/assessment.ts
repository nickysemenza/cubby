import { defineChildTable } from "../entity-definitions/child-definition.js";

/** Histories have no live entity/Run ownership: current edges belong to the projection. */
export const assessmentChildren = [
  defineChildTable({
    name: "Assessment",
    exportName: "assessment",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "publicationKey", kind: "text", notNull: true },
      { key: "family", kind: "text", notNull: true, type: "AssessmentFamily" },
      {
        key: "subject",
        kind: "jsonb",
        notNull: true,
        type: "AssessmentSubject",
      },
      { key: "judgment", kind: "jsonb", notNull: true },
      { key: "fingerprint", kind: "text" },
      { key: "producer", kind: "jsonb", type: "AssessmentProducer" },
      { key: "evidence", kind: "jsonb" },
      { key: "origin", kind: "jsonb" },
      { key: "served", kind: "boolean", notNull: true, default: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/assessment",
        exports: [
          "AssessmentFamily",
          "AssessmentSubject",
          "AssessmentProducer",
        ],
      },
    ],
    indexes: [
      {
        name: "Assessment_publication_key",
        unique: true,
        on: ["publicationKey"],
      },
      { name: "Assessment_family_idx", on: ["family", "createdAt"] },
    ],
  }),
  defineChildTable({
    name: "Feedback",
    exportName: "feedback",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "assessmentId",
        kind: "uuid",
        notNull: true,
        reference: { table: "assessment", column: "id" },
      },
      { key: "operationId", kind: "text", notNull: true },
      { key: "verdict", kind: "text", notNull: true },
      {
        key: "correction",
        kind: "jsonb",
        notNull: true,
        type: "AssessmentCorrection",
      },
      { key: "reason", kind: "text" },
      { key: "evidence", kind: "jsonb" },
      { key: "intent", kind: "text", notNull: true },
      { key: "authority", kind: "text", notNull: true },
      { key: "actorUserId", kind: "text" },
      { key: "suppression", kind: "jsonb", type: "AssessmentSuppression" },
      { key: "receipt", kind: "jsonb" },
      { key: "metadata", kind: "jsonb" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/assessment",
        exports: ["AssessmentCorrection", "AssessmentSuppression"],
      },
    ],
    indexes: [
      {
        name: "Feedback_operation_key",
        unique: true,
        on: ["assessmentId", "operationId"],
      },
      { name: "Feedback_assessment_idx", on: ["assessmentId", "createdAt"] },
    ],
    checks: [
      {
        name: "Feedback_verdict_check",
        sql: "{verdict} IN ('correct', 'wrong', 'uncertain', 'dismissed', 'ungraded')",
      },
      {
        name: "Feedback_authority_check",
        sql: "{authority} IN ('member', 'evaluation', 'automatic', 'unknown')",
      },
    ],
  }),
  defineChildTable({
    name: "AssessmentState",
    exportName: "assessmentState",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        reference: { table: "run", column: "id", onDelete: "set null" },
      },
      { key: "entity", kind: "text", notNull: true },
      { key: "recordId", kind: "uuid", notNull: true },
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
      { key: "pairKey", kind: "uuid" },
      { key: "kind", kind: "text", notNull: true, default: "addition" },
      {
        key: "status",
        kind: "text",
        notNull: true,
        default: { sql: "'pending'" },
      },
      { key: "correctValue", kind: "jsonb" },
      {
        key: "family",
        kind: "text",
        notNull: true,
        default: "field",
        type: "AssessmentFamily",
      },
      {
        key: "data",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'{}'::jsonb" },
      },
      { key: "fingerprint", kind: "text" },
      { key: "confirmedValue", kind: "jsonb", type: "AssessmentCorrection" },
      { key: "suppression", kind: "jsonb", type: "AssessmentSuppression" },
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
        module: "@cubby/schemas/assessment",
        exports: [
          "AssessmentFamily",
          "AssessmentCorrection",
          "AssessmentSuppression",
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
    foreignKeys: [
      {
        name: "AssessmentState_history_fk",
        columns: ["id"],
        table: "assessment",
        references: ["id"],
      },
    ],
    indexes: [
      {
        name: "AssessmentState_family_active_idx",
        on: ["family", "active", "status"],
      },
      { name: "AssessmentState_run_status_idx", on: ["runId", "status"] },
      { name: "AssessmentState_evaluation_idx", on: ["evaluationId"] },
      {
        name: "AssessmentState_entity_field_status_idx",
        on: ["entity", "field", "status"],
      },
      {
        name: "AssessmentState_entity_record_status_idx",
        on: ["entity", "recordId", "status"],
      },
    ],
    checks: [
      {
        name: "AssessmentState_kind_check",
        sql: "{kind} IN ('correction', 'addition')",
      },
      {
        name: "AssessmentState_status_check",
        sql: "{status} IN ('pending', 'applied', 'rejected', 'superseded', 'resolved')",
      },
      {
        name: "AssessmentState_confidence_check",
        sql: "{confidence} BETWEEN 0 AND 1",
      },
    ],
  }),
];

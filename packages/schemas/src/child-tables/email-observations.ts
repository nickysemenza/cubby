import { defineChildTable } from "../entity-definitions/child-definition.js";

/** Immutable predictions, member labels and raw retrieval history are separate records. */
export const emailObservationChildren = [
  defineChildTable({
    name: "EmailCandidateObservation",
    exportName: "emailCandidateObservation",
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
        reference: { table: "email", column: "id" },
      },
      { key: "runId", kind: "uuid", reference: { table: "run", column: "id" } },
      {
        key: "preview",
        kind: "jsonb",
        notNull: true,
        type: "EmailCandidatePreview",
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
        module: "@cubby/schemas/email-candidates",
        exports: ["EmailCandidatePreview"],
      },
    ],
    indexes: [{ name: "EmailCandidateObservation_email_idx", on: ["emailId"] }],
  }),
  defineChildTable({
    name: "EmailClassificationObservation",
    exportName: "emailClassificationObservation",
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
        reference: { table: "email", column: "id" },
      },
      { key: "runId", kind: "uuid", reference: { table: "run", column: "id" } },
      { key: "checksum", kind: "text" },
      {
        key: "classification",
        kind: "text",
        notNull: true,
        type: "MailboxClassification",
      },
      {
        key: "stage",
        kind: "text",
        type: "MailboxClassificationStage",
      },
      { key: "reason", kind: "text" },
      { key: "classificationVersion", kind: "text" },
      { key: "model", kind: "text" },
      { key: "promptVersion", kind: "text" },
      { key: "operation", kind: "text", type: "EmailClassificationOperation" },
      {
        key: "usageId",
        kind: "uuid",
        reference: { table: "aiUsage", column: "id" },
      },
      { key: "provenance", kind: "jsonb", type: "AiProvenance" },
      {
        key: "evaluationId",
        kind: "uuid",
        reference: { table: "aiEvaluation", column: "id" },
      },
      { key: "conflict", kind: "jsonb", type: "EmailClassificationConflict" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      { module: "@cubby/schemas/ai-evaluation", exports: ["AiProvenance"] },
      {
        module: "@cubby/schemas/mailbox-research",
        exports: ["MailboxClassification", "MailboxClassificationStage"],
      },
      {
        module: "@cubby/schemas/email-observations",
        exports: [
          "EmailClassificationConflict",
          "EmailClassificationOperation",
        ],
      },
    ],
    indexes: [
      { name: "EmailClassificationObservation_email_idx", on: ["emailId"] },
      {
        name: "EmailClassificationObservation_evaluation_idx",
        on: ["evaluationId"],
      },
    ],
    checks: [
      {
        name: "EmailClassificationObservation_operation_check",
        sql: "{operation} IN ('mailbox-triage', 'mailbox-relevance')",
      },
      {
        name: "EmailClassificationObservation_classification_check",
        sql: "{classification} IN ('related', 'unrelated', 'uncertain')",
      },
      {
        name: "EmailClassificationObservation_stage_check",
        sql: "{stage} IN ('rule', 'decision', 'model', 'resolution')",
      },
    ],
  }),
  defineChildTable({
    name: "EmailClassificationLabel",
    exportName: "emailClassificationLabel",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "predictionId",
        kind: "uuid",
        notNull: true,
        reference: { table: "emailClassificationObservation", column: "id" },
      },
      {
        key: "classification",
        kind: "text",
        notNull: true,
        type: "MailboxClassification",
      },
      { key: "reason", kind: "text", notNull: true },
      {
        key: "actorUserId",
        kind: "text",
        notNull: true,
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
        module: "@cubby/schemas/mailbox-research",
        exports: ["MailboxClassification"],
      },
    ],
    indexes: [
      { name: "EmailClassificationLabel_prediction_idx", on: ["predictionId"] },
    ],
    checks: [
      {
        name: "EmailClassificationLabel_classification_check",
        sql: "{classification} IN ('related', 'unrelated', 'uncertain')",
      },
    ],
  }),
  defineChildTable({
    name: "EmailRetrievalFailure",
    exportName: "emailRetrievalFailure",
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
        reference: { table: "email", column: "id" },
      },
      { key: "runId", kind: "uuid", reference: { table: "run", column: "id" } },
      { key: "httpStatus", kind: "integer" },
      { key: "error", kind: "text", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [{ name: "EmailRetrievalFailure_email_idx", on: ["emailId"] }],
    checks: [
      {
        name: "EmailRetrievalFailure_httpStatus_check",
        sql: "{httpStatus} BETWEEN 100 AND 599",
      },
    ],
  }),
];

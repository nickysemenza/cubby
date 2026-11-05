import {
  AUTOMATIC_RULE_FAMILIES,
  AUTOMATIC_RULE_KEYS,
} from "../automatic-rule.js";
import { defineChildTable } from "../entity-definitions/child-definition.js";

const sqlList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(", ");

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
      { key: "projection", kind: "jsonb" },
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
      {
        name: "Assessment_served_other_id_idx",
        on: [{ sql: "md5({subject}->>'otherId')" }],
        where: "{served} AND ({subject}->>'otherId') IS NOT NULL",
      },
      {
        name: "Assessment_served_source_ref_idx",
        on: [
          { sql: "md5({judgment} #>> '{create,sourceRef,source}')" },
          { sql: "md5({judgment} #>> '{create,sourceRef,externalId}')" },
        ],
        where:
          "{served} AND ({judgment} #>> '{create,sourceRef,source}') IS NOT NULL AND ({judgment} #>> '{create,sourceRef,externalId}') IS NOT NULL",
      },
      {
        name: "Assessment_reference_records_idx",
        using: "gin",
        on: [{ sql: "({evidence}->'records')" }],
        where: "{served}",
      },
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
      { key: "projection", kind: "jsonb" },
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
        sql: "{authority} IN ('member', 'evaluation', 'automatic', 'unknown', 'system')",
      },
      {
        name: "Feedback_system_check",
        sql: "{authority} <> 'system' OR ({actorUserId} IS NULL AND {verdict} = 'ungraded' AND {suppression} IS NULL)",
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
      {
        key: "ledgerPartyId",
        kind: "uuid",
        reference: { table: "ledgerParty", column: "id" },
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
      {
        name: "AssessmentState_active_suppression_idx",
        on: ["entity", "recordId"],
        where: "{active} AND {suppression} IS NOT NULL",
      },
      {
        name: "AssessmentState_ledger_party_idx",
        on: ["ledgerPartyId", "family", "status"],
      },
      { name: "AssessmentState_evaluation_idx", on: ["evaluationId"] },
      {
        name: "AssessmentState_entity_field_status_idx",
        on: ["entity", "field", "status"],
      },
      {
        name: "AssessmentState_entity_record_status_idx",
        on: ["entity", "recordId", "status"],
      },
      {
        name: "AssessmentState_active_value_status_idx",
        on: ["status", { sql: "md5({suggestedValue} #>> '{}')" }],
        where: "{active}",
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
  /**
   * The member-owned switch of each Automatic rule. The rule itself is a code
   * declaration; its precision is computed from Feedback on read.
   */
  defineChildTable({
    name: "AutomaticRule",
    exportName: "automaticRule",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "family",
        kind: "text",
        notNull: true,
        values: [...AUTOMATIC_RULE_FAMILIES],
      },
      {
        key: "ruleKey",
        kind: "text",
        notNull: true,
        values: [...AUTOMATIC_RULE_KEYS],
      },
      /** The revision `enabled` was last set for. */
      { key: "revision", kind: "text", notNull: true },
      { key: "enabled", kind: "boolean", notNull: true, default: false },
      { key: "enabledAt", kind: "timestamp" },
      {
        key: "enabledByUserId",
        kind: "text",
        type: "UserId",
        reference: { table: "user", column: "id" },
      },
      { key: "enabledReason", kind: "text" },
      { key: "disabledAt", kind: "timestamp" },
      { key: "disabledReason", kind: "text" },
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
    types: [{ module: "@cubby/schemas/identifiers", exports: ["UserId"] }],
    indexes: [
      {
        name: "AutomaticRule_family_key",
        unique: true,
        on: ["family", "ruleKey"],
      },
    ],
    checks: [
      {
        name: "AutomaticRule_family_check",
        sql: `{family} IN (${sqlList(AUTOMATIC_RULE_FAMILIES)})`,
      },
      {
        name: "AutomaticRule_key_check",
        sql: `{ruleKey} IN (${sqlList(AUTOMATIC_RULE_KEYS)}) AND starts_with({ruleKey}, {family} || '.')`,
      },
    ],
  }),
  // Staged and active revisions share one relation; only active rows serve reads.
  defineChildTable({
    name: "AssessmentReadPublication",
    exportName: "assessmentReadPublication",
    columns: [
      {
        key: "assessmentId",
        kind: "uuid",
        notNull: true,
        reference: { table: "assessment", column: "id" },
      },
      { key: "revision", kind: "uuid", notNull: true },
      { key: "family", kind: "text", type: "SuggestionListFamily" },
      { key: "active", kind: "boolean", notNull: true, default: false },
      { key: "rulesVersion", kind: "integer", notNull: true },
      { key: "contentHash", kind: "text", notNull: true },
      { key: "groupKey", kind: "text", notNull: true },
      { key: "admitted", kind: "boolean", notNull: true },
      { key: "computedAt", kind: "timestamp", notNull: true },
      /** Household day verified for a clock-sensitive component; independent of publication age. */
      { key: "clockDay", kind: "date" },
      { key: "key", kind: "jsonb", type: "AssessmentReadKey" },
      { key: "filters", kind: "jsonb", type: "AssessmentReadFilterFacts" },
      { key: "row", kind: "jsonb", type: "SuggestionListRow" },
      {
        key: "dependencies",
        kind: "jsonb",
        notNull: true,
        type: "AssessmentReadDependency[]",
      },
    ],
    types: [
      {
        module: "@cubby/schemas/assessment-read-publication",
        exports: [
          "AssessmentReadKey",
          "AssessmentReadFilterFacts",
          "AssessmentReadDependency",
        ],
      },
      {
        module: "@cubby/schemas/suggestion-list",
        exports: ["SuggestionListFamily", "SuggestionListRow"],
      },
    ],
    indexes: [
      {
        name: "AssessmentReadPublication_revision_family_key",
        unique: true,
        on: ["assessmentId", "revision", { sql: "coalesce({family}, '')" }],
      },
      {
        name: "AssessmentReadPublication_active_family_key",
        unique: true,
        on: ["assessmentId", { sql: "coalesce({family}, '')" }],
        where: "{active}",
      },
      {
        name: "AssessmentReadPublication_family_idx",
        on: ["family", "assessmentId"],
        where: "{active}",
      },
      {
        name: "AssessmentReadPublication_group_idx",
        on: ["groupKey", "assessmentId"],
        where: "{active}",
      },
      {
        name: "AssessmentReadPublication_rules_idx",
        on: ["rulesVersion"],
        where: "{active}",
      },
    ],
    checks: [
      {
        name: "AssessmentReadPublication_result_check",
        sql: "({admitted} AND {family} IS NOT NULL AND {key} IS NOT NULL AND {filters} IS NOT NULL AND {row} IS NOT NULL) OR (NOT {admitted} AND {family} IS NULL AND {key} IS NULL AND {filters} IS NULL AND {row} IS NULL)",
      },
    ],
  }),
  defineChildTable({
    name: "AssessmentReadMembership",
    exportName: "assessmentReadMembership",
    columns: [
      {
        key: "assessmentId",
        kind: "uuid",
        notNull: true,
        reference: { table: "assessment", column: "id" },
      },
      { key: "revision", kind: "uuid", notNull: true },
      { key: "entity", kind: "text", notNull: true, type: "Entity" },
      { key: "kind", kind: "text", notNull: true },
      { key: "value", kind: "text", notNull: true },
      {
        key: "stateFamily",
        kind: "text",
        notNull: true,
        type: "AssessmentFamily",
      },
      { key: "retained", kind: "boolean", notNull: true },
      { key: "ordinal", kind: "integer", notNull: true },
    ],
    types: [
      { module: "@cubby/schemas/entity-core", exports: ["Entity"] },
      { module: "@cubby/schemas/assessment", exports: ["AssessmentFamily"] },
    ],
    indexes: [
      {
        name: "AssessmentReadMembership_revision_ordinal_key",
        unique: true,
        on: ["assessmentId", "revision", "kind", "ordinal"],
      },
      {
        name: "AssessmentReadMembership_entity_idx",
        on: ["kind", "entity", "assessmentId", "revision"],
      },
      {
        name: "AssessmentReadMembership_value_idx",
        on: ["kind", { sql: "md5({value})" }, "assessmentId", "revision"],
      },
    ],
    checks: [
      {
        name: "AssessmentReadMembership_kind_check",
        sql: "{kind} IN ('scope', 'ref')",
      },
      { name: "AssessmentReadMembership_ordinal_check", sql: "{ordinal} >= 0" },
    ],
  }),
  defineChildTable({
    name: "AssessmentReadDependency",
    exportName: "assessmentReadDependency",
    columns: [
      {
        key: "assessmentId",
        kind: "uuid",
        notNull: true,
        reference: { table: "assessment", column: "id" },
      },
      { key: "sourceKind", kind: "text", notNull: true },
      { key: "sourceId", kind: "uuid", notNull: true },
    ],
    indexes: [
      {
        name: "AssessmentReadDependency_source_key",
        unique: true,
        on: ["assessmentId", "sourceKind", "sourceId"],
      },
      {
        name: "AssessmentReadDependency_reverse_idx",
        on: ["sourceId", "sourceKind", "assessmentId"],
      },
    ],
  }),
  // These rows stage bounded preparation; readers use only the active header's revision.
  defineChildTable({
    name: "AssessmentReadStage",
    exportName: "assessmentReadStage",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "componentKey", kind: "text", notNull: true },
      {
        key: "groups",
        kind: "jsonb",
        notNull: true,
        type: "AssessmentReadGroupKeys",
      },
      { key: "assessmentIds", kind: "uuid", array: true, notNull: true },
      {
        key: "tickets",
        kind: "jsonb",
        notNull: true,
        type: "AssessmentReadObservedTicket[]",
      },
      { key: "revision", kind: "uuid", notNull: true },
      { key: "nextIndex", kind: "integer", notNull: true, default: 0 },
      { key: "rulesVersion", kind: "integer", notNull: true },
      { key: "clockDay", kind: "date" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/assessment-read-publication",
        exports: ["AssessmentReadGroupKeys", "AssessmentReadObservedTicket"],
      },
    ],
    indexes: [
      {
        name: "AssessmentReadStage_component_key",
        unique: true,
        on: ["componentKey"],
      },
      {
        name: "AssessmentReadStage_revision_key",
        unique: true,
        on: ["revision"],
      },
    ],
    checks: [
      {
        name: "AssessmentReadStage_progress_check",
        sql: "cardinality({assessmentIds}) > 0 AND {nextIndex} >= 0 AND {nextIndex} <= cardinality({assessmentIds})",
      },
    ],
  }),
];

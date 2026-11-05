import {
  AUTOMATIC_RULE_FAMILIES,
  AUTOMATIC_RULE_KEYS,
} from "../automatic-rule.js";
import { defineChildTable } from "../entity-definitions/child-definition.js";

const sqlList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(", ");

export const assessmentChildren = [
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
      { key: "family", kind: "text", notNull: true, type: "AssessmentFamily" },
      {
        key: "subject",
        kind: "jsonb",
        notNull: true,
        type: "AssessmentSubject",
      },
      { key: "judgment", kind: "jsonb", notNull: true },
      { key: "producer", kind: "jsonb", type: "AssessmentProducer" },
      { key: "evidence", kind: "jsonb" },
      { key: "served", kind: "boolean", notNull: true, default: true },
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
          "AssessmentSubject",
          "AssessmentProducer",
          "AssessmentCorrection",
          "AssessmentSuppression",
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
        where: "{served} AND ({subject}->>'otherId') IS NOT NULL",
      },
      {
        name: "Suggestion_served_source_ref_idx",
        on: [
          { sql: "md5({judgment} #>> '{create,sourceRef,source}')" },
          { sql: "md5({judgment} #>> '{create,sourceRef,externalId}')" },
        ],
        where:
          "{served} AND ({judgment} #>> '{create,sourceRef,source}') IS NOT NULL AND ({judgment} #>> '{create,sourceRef,externalId}') IS NOT NULL",
      },
      {
        name: "Suggestion_reference_records_idx",
        using: "gin",
        on: [{ sql: "({evidence}->'records')" }],
        where: "{served}",
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
      { key: "key", kind: "jsonb" },
      { key: "filters", kind: "jsonb" },
      { key: "row", kind: "jsonb", type: "SuggestionListRow" },
      {
        key: "dependencies",
        kind: "jsonb",
        notNull: true,
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
      },
      { key: "assessmentIds", kind: "uuid", array: true, notNull: true },
      {
        key: "tickets",
        kind: "jsonb",
        notNull: true,
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

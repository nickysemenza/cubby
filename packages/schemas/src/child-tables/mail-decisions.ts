import { defineChildTable } from "../entity-definitions/child-definition.js";

/**
 * Mail decisions owned by the Email/import domain (ADR 0011). A decision is the
 * current link or dismissal of one order event for one Purchase; a review is an
 * append-only record of who judged what. Neither references the removable Email
 * or Purchase: both survive their target's lifecycle as retained evidence.
 */
export const mailDecisionChildren = [
  defineChildTable({
    name: "EmailPurchaseDecision",
    exportName: "emailPurchaseDecision",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "eventId", kind: "uuid", notNull: true },
      { key: "purchaseId", kind: "uuid", notNull: true, type: "PurchaseId" },
      {
        key: "decision",
        kind: "text",
        notNull: true,
        type: "EmailPurchaseDecisionValue",
      },
      { key: "evidenceChecksum", kind: "text", notNull: true },
      { key: "decidedByUserId", kind: "text", notNull: true },
      { key: "proposedBy", kind: "text", type: "EmailLinkProposer" },
      { key: "authority", kind: "text", notNull: true },
      { key: "status", kind: "text", notNull: true, default: "resolved" },
      { key: "active", kind: "boolean", notNull: true, default: true },
      /** The current Email target; a removed Email leaves the retained event. */
      { key: "emailId", kind: "uuid" },
      { key: "originalId", kind: "uuid", notNull: true },
      { key: "producer", kind: "jsonb", type: "AssessmentProducer" },
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
      { module: "@cubby/schemas/identifiers", exports: ["PurchaseId"] },
      {
        module: "@cubby/schemas/email-fields",
        exports: ["EmailLinkProposer", "EmailPurchaseDecisionValue"],
      },
      { module: "@cubby/schemas/assessment", exports: ["AssessmentProducer"] },
    ],
    indexes: [
      {
        name: "EmailPurchaseDecision_event_purchase_key",
        unique: true,
        on: ["eventId", "purchaseId"],
        where: "{active}",
      },
      {
        // The member retry in decideEmailPurchase matches this name.
        name: "EmailPurchaseDecision_one_link_key",
        unique: true,
        on: ["eventId"],
        where: "{active} AND {decision} = 'linked'",
      },
      {
        name: "EmailPurchaseDecision_purchase_idx",
        on: ["purchaseId"],
        where: "{active}",
      },
      { name: "EmailPurchaseDecision_email_idx", on: ["emailId"] },
      { name: "EmailPurchaseDecision_original_idx", on: ["originalId"] },
    ],
    checks: [
      {
        name: "EmailPurchaseDecision_decision_check",
        sql: "{decision} IN ('linked', 'dismissed')",
      },
      {
        name: "EmailPurchaseDecision_authority_check",
        sql: "{authority} IN ('member', 'automatic', 'unknown')",
      },
      {
        name: "EmailPurchaseDecision_status_check",
        sql: "{status} IN ('resolved', 'applied', 'rejected', 'superseded')",
      },
    ],
  }),
  defineChildTable({
    name: "EmailReview",
    exportName: "emailReview",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "family", kind: "text", notNull: true, type: "AssessmentFamily" },
      /** The reviewed handle: an observation, decision, or outcome id. */
      { key: "subjectId", kind: "uuid", notNull: true },
      { key: "emailId", kind: "uuid" },
      { key: "originalId", kind: "uuid" },
      { key: "checksum", kind: "text" },
      {
        key: "classification",
        kind: "text",
        type: "MailboxClassification",
      },
      { key: "operationId", kind: "text", notNull: true },
      { key: "verdict", kind: "text", notNull: true },
      /** Keeps `present`, so an explicit JSON null differs from no correction. */
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
      { key: "subject", kind: "jsonb", notNull: true },
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
        exports: ["AssessmentCorrection", "AssessmentFamily"],
      },
      {
        module: "@cubby/schemas/mailbox-research",
        exports: ["MailboxClassification"],
      },
    ],
    indexes: [
      {
        name: "EmailReview_operation_key",
        unique: true,
        on: ["subjectId", "operationId"],
      },
      {
        name: "EmailReview_email_idx",
        on: ["emailId", { column: "createdAt", desc: true }],
      },
      {
        name: "EmailReview_original_idx",
        on: ["originalId"],
        where: "{emailId} IS NULL",
      },
    ],
    checks: [
      {
        name: "EmailReview_family_check",
        sql: "{family} IN ('email_relevance', 'email_link', 'mail_import_outcome', 'recommendation')",
      },
      {
        name: "EmailReview_verdict_check",
        sql: "{verdict} IN ('correct', 'wrong', 'uncertain', 'dismissed', 'ungraded')",
      },
      {
        name: "EmailReview_authority_check",
        sql: "{authority} IN ('member', 'automatic', 'unknown', 'system')",
      },
      {
        name: "EmailReview_classification_check",
        sql: "{classification} IN ('related', 'unrelated', 'uncertain')",
      },
    ],
  }),
];

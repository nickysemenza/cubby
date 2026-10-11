import { z } from "zod";

import {
  ledgerPartyShortcode,
  runShortcode,
  shortcodeSchema,
} from "../identifier-fields.js";
import {
  MAILBOX_CLASSIFICATION_LABEL,
  MAILBOX_CLASSIFICATION_STAGE_LABEL,
  mailboxClassification,
  mailboxClassificationStage,
  emailStatus,
} from "../mailbox-research.js";
import { defineEntity } from "./definition.js";
import { labelField } from "./label-field";

const readOnly = <T extends z.ZodTypeAny>(read: T) => ({
  read,
  create: null,
  update: null,
});
const relevanceOptions = mailboxClassification.options.map((value) => ({
  value,
  label: MAILBOX_CLASSIFICATION_LABEL[value],
}));
const stageOptions = mailboxClassificationStage.options.map((value) => ({
  value,
  label: MAILBOX_CLASSIFICATION_STAGE_LABEL[value],
}));
const statusOptions = emailStatus.options.map((value) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
}));

/** The promoted processing ledger owns identity and headers; retained content is optional. */
export default defineEntity({
  key: "email",
  names: { singular: "Email", plural: "Emails" },
  route: { basePath: "emails" },
  // Preserve processing UUIDs and existing writers until the contract migration.
  table: "Email",
  identifiers: { brand: "EmailId", shortcode: "EML-" },
  presentation: {
    titleField: "displayName",
    domain: "finance",
    description: "Scanned mailbox messages, their Relevance and import status.",
    emptyState: {
      title: "No Emails yet",
      description: "Mail discovery records metadata for every scanned message.",
    },
    icons: { phosphor: "Envelope", sfSymbol: "envelope", emoji: "✉️" },
    detail: {
      hero: { chip: "classification", stats: [] },
      additionalSections: [
        { kind: "slot", id: "review", title: "Review and import" },
      ],
    },
    list: {
      read: { media: ["displayImages"], quality: ["dataQuality"] },
      views: ["table", { kind: "slot", id: "accuracy", label: "Accuracy" }],
      savedViews: [
        {
          id: "pipeline-worklist",
          label: "Needs attention",
          description:
            "Emails whose Relevance, review, original, preview or import is incomplete, weakest first",
          filters: [
            {
              id: "dataGaps",
              value: [
                "email_relevance_undecided",
                "email_relevance_unreviewed",
                "email_original_missing",
                "email_preview_missing",
                "email_not_imported",
              ],
            },
          ],
          sort: [{ id: "dataQuality", desc: false }],
          layout: { columnVisibility: { dataGaps: true } },
        },
        {
          id: "review-conflicts",
          label: "Review conflicts",
          description:
            "Emails whose latest rule, Jev or model result disagrees with the member's review",
          filters: [{ id: "reviewConflict", value: "true" }],
          sort: [{ id: "receivedAt", desc: true }],
          layout: { columnVisibility: { classificationReason: true } },
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "id",
        kind: "identifier",
        validation: readOnly(shortcodeSchema("email")),
      },
      {
        key: "displayName",
        kind: "text",
        validation: readOnly(z.string().min(1)),
      },
      {
        key: "sender",
        kind: "text",
        nullable: true,
        display: { list: true, detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "subject",
        kind: "text",
        nullable: true,
        display: { list: true, listHidden: true, detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "receivedAt",
        kind: "timestamp",
        nullable: true,
        labelOverride: "Received",
        display: { list: true, detail: true, format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "classification",
        kind: "enum",
        nullable: true,
        labelOverride: "Relevance",
        control: { kind: "select", options: relevanceOptions },
        // The list cell names the deciding stage, e.g. "Uncertain · Rule".
        display: { list: true, detail: true, labelPath: "relevanceLabel" },
        validation: readOnly(mailboxClassification.nullable()),
      },
      labelField("relevanceLabel", "Relevance and its deciding stage"),
      {
        key: "classificationStage",
        kind: "enum",
        nullable: true,
        labelOverride: "Relevance stage",
        control: { kind: "select", options: stageOptions },
        display: { list: true, listHidden: true, detail: true },
        validation: readOnly(mailboxClassificationStage.nullable()),
      },
      {
        key: "classificationReason",
        kind: "text",
        nullable: true,
        labelOverride: "Relevance reason",
        display: { list: true, listHidden: true, detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "reviewedClassification",
        kind: "enum",
        nullable: true,
        labelOverride: "Reviewed relevance",
        control: { kind: "select", options: relevanceOptions },
        display: { list: true, detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "Independent review of this Email checksum" }],
        },
        validation: readOnly(mailboxClassification.nullable()),
      },
      {
        key: "reviewConflict",
        kind: "boolean",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Latest rule, Jev or model result disagrees with the member's resolution or review",
            },
          ],
        },
        display: { list: true, listHidden: true, detail: true },
        validation: readOnly(z.boolean()),
      },
      {
        key: "reviewedClassificationReason",
        kind: "text",
        nullable: true,
        labelOverride: "Review reason",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ label: "Independent review of this Email checksum" }],
        },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "status",
        kind: "enum",
        control: { kind: "select", options: statusOptions },
        display: { list: true, detail: true },
        validation: readOnly(emailStatus),
      },
      {
        key: "mailboxId",
        kind: "text",
        labelOverride: "Mailbox",
        display: { list: true, listHidden: true, detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        reference: { entity: "ledgerParty" },
        labelOverride: "Owner",
        display: { detail: true },
        validation: readOnly(ledgerPartyShortcode),
      },
      {
        key: "ledgerPartyName",
        kind: "text",
        nullable: true,
        provenance: { kind: "derived", sources: [{ label: "Email owner" }] },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "provider",
        kind: "text",
        display: { detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "messageId",
        kind: "text",
        labelOverride: "Provider message ID",
        display: { detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "threadId",
        kind: "text",
        nullable: true,
        display: { detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "historyId",
        kind: "text",
        nullable: true,
        display: { detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "checksum",
        kind: "text",
        display: { detail: true },
        validation: readOnly(z.string()),
      },
      {
        key: "classificationVersion",
        kind: "text",
        nullable: true,
        display: { detail: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "runId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "run" },
        labelOverride: "Processing Run",
        display: { detail: true },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "linked",
        kind: "boolean",
        provenance: {
          kind: "derived",
          sources: [
            { label: "Accepted import sources and active lifecycle links" },
          ],
        },
        display: { detail: true },
        validation: readOnly(z.boolean()),
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: readOnly(z.date()),
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: readOnly(z.date()),
      },
      { key: "shortcode", kind: "text" },
      { key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      { key: "id", specialized: "primary-key:EmailId" },
      { key: "shortcode", specialized: "shortcode" },
      { key: "ledgerPartyId", reference: "ledgerParty" },
      { key: "provider", defaultValue: "gmail" },
      "mailboxId",
      "messageId",
      "sender",
      "subject",
      "receivedAt",
      "threadId",
      "historyId",
      "checksum",
      { key: "classification", specialized: "enum:classification" },
      "classificationVersion",
      { key: "classificationStage", specialized: "enum:classificationStage" },
      "classificationReason",
      { key: "status", specialized: "enum:status" },
      { key: "runId", reference: "run" },
      "createdAt",
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    output: [
      "id",
      "displayName",
      "sender",
      "subject",
      "receivedAt",
      "classification",
      "relevanceLabel",
      "classificationStage",
      "classificationReason",
      "reviewedClassification",
      "reviewedClassificationReason",
      "reviewConflict",
      "status",
      "mailboxId",
      "ledgerPartyId",
      "ledgerPartyName",
      "provider",
      "messageId",
      "threadId",
      "historyId",
      "checksum",
      "classificationVersion",
      "runId",
      "linked",
      "createdAt",
      "updatedAt",
    ],
    create: [],
    update: [],
    bulk: [],
    audit: [],
    sort: {
      fields: [
        "receivedAt",
        "sender",
        "subject",
        "classification",
        "classificationStage",
        "status",
        "mailboxId",
        "createdAt",
        "updatedAt",
      ],
    },
  },
  fields: {
    create: null,
    update: null,
    output: { module: "@cubby/schemas/email", export: "emailOut" },
  },
  storage: {
    // Transitional pointer: the content/events/attachments keep their UUIDs.
    columns: [
      { key: "orderMailId", kind: "identifier", reference: "orderMail" },
      {
        key: "executionPolicy",
        kind: "text",
        type: {
          module: "@cubby/schemas/email-fields",
          export: "EmailExecutionPolicy",
        },
      },
      {
        key: "searchOrigin",
        kind: "text",
        type: {
          module: "@cubby/schemas/email-fields",
          export: "EmailSearchOrigin",
        },
      },
      { key: "searchExpiresAt", kind: "timestamp" },
      { key: "contentClearedAt", kind: "timestamp" },
    ],
    relations: {
      content: { one: "orderMail", field: "orderMailId", references: "id" },
    },
    indexes: [
      {
        name: "Email_mailbox_message_key",
        unique: true,
        on: ["ledgerPartyId", "provider", "mailboxId", "messageId"],
      },
      {
        name: "Email_pending_idx",
        on: ["ledgerPartyId", "mailboxId", "status"],
      },
      { on: ["orderMailId"], unique: true, where: "{orderMailId} IS NOT NULL" },
      { on: ["ledgerPartyId", { column: "receivedAt", desc: true }] },
    ],
    checks: [
      {
        name: "Email_executionPolicy_check",
        sql: "{executionPolicy} IS NULL OR {executionPolicy} IN ('classification_only', 'import')",
      },
      {
        name: "Email_searchOrigin_check",
        sql: "{searchOrigin} IS NULL OR {searchOrigin} IN ('member_search', 'discovery')",
      },
      {
        name: "Email_classification_check",
        column: "classification",
        bare: true,
      },
      {
        name: "Email_classification_stage_check",
        column: "classificationStage",
        nullClause: true,
        bare: true,
      },
      { name: "Email_status_check", column: "status", bare: true },
    ],
  },
  filters: {
    schema: { module: "@cubby/schemas/email", export: "emailFilterFields" },
    descriptors: [
      {
        columnId: "sender",
        kind: "text",
        placeholder: "Filter by sender...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "subject",
        kind: "text",
        placeholder: "Filter by subject...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "receivedAt",
        kind: "range",
        placeholder: "Filter by received date...",
        deriveSchema: true,
      },
      {
        columnId: "classification",
        kind: "multiselect",
        placeholder: "Filter by Relevance...",
        deriveSchema: true,
        stored: true,
        options: relevanceOptions,
      },
      {
        columnId: "classificationStage",
        kind: "multiselect",
        placeholder: "Filter by Relevance stage...",
        deriveSchema: true,
        stored: true,
        options: stageOptions,
      },
      {
        columnId: "classificationReason",
        kind: "text",
        placeholder: "Filter by Relevance reason...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        stored: true,
        options: statusOptions,
      },
      {
        columnId: "mailboxId",
        kind: "text",
        placeholder: "Filter by mailbox...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "provider",
        kind: "text",
        placeholder: "Filter by provider...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by owner...",
        brandRef: { entity: "ledgerParty" },
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "runId",
        kind: "idMulti",
        placeholder: "Filter by Run...",
        brandRef: { entity: "run" },
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "linked",
        kind: "boolean",
        placeholder: "Filter by Purchase association...",
        deriveSchema: true,
        options: [
          { value: "true", label: "Linked" },
          { value: "false", label: "Unlinked" },
        ],
      },
      {
        columnId: "reviewConflict",
        kind: "boolean",
        placeholder: "Stage disagrees with review",
        deriveSchema: true,
        options: [
          { value: "true", label: "Stage disagrees with review" },
          { value: "false", label: "No review conflict" },
        ],
      },
    ],
  },
  relations: [
    {
      key: "ledger-party",
      label: "Owner",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Email.ledgerPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Email.ledgerPartyId", direction: "incoming" }],
      },
    },
    {
      key: "run",
      label: "Current import Run",
      target: "run",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Email.runId", direction: "outgoing" }],
      },
      inverse: { steps: [{ edge: "Email.runId", direction: "incoming" }] },
    },
  ],
  search: false,
  capabilities: {
    auditable: false,
    images: { storage: false },
    softDelete: false,
    delete: null,
    bulkUpdate: null,
    merge: false,
    lifecycle: "readOnly",
    // Relevance-conditional Email pipeline gaps; an unrelated Email can only
    // lack a member review.
    dataQuality: {
      checks: [
        {
          id: "email_relevance_undecided",
          facet: "content",
          weight: 3,
          label: "Relevance",
          message: "Relevance is uncertain.",
        },
        {
          id: "email_relevance_unreviewed",
          facet: "provenance",
          weight: 1,
          label: "Member review",
          message:
            "A rule, Jev or the relevance model decided; no member review.",
        },
        {
          id: "email_original_missing",
          facet: "integrity",
          weight: 2,
          label: "Original",
          message: "The original content is not retained.",
        },
        {
          id: "email_preview_missing",
          facet: "content",
          weight: 1,
          label: "Extraction preview",
          message: "No extraction preview for the current original.",
        },
        {
          id: "email_not_imported",
          facet: "linkage",
          weight: 3,
          label: "Import",
          message: "No associated Purchase or completed import Run.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: { module: "~/server/repo/email", export: "emailRepository" },
    },
  },
});

import type { ColorToken, EnumIcon } from "@cubby/shared/enum-palette";
import { z } from "zod";
import {
  EMAIL_LINK_STATE_LABEL,
  emailImportOutcome,
  emailLinkState,
  emailPurchaseLink,
} from "../email-fields.js";
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

type OptionPresentation = { color: ColorToken; glyph?: EnumIcon };

const RELEVANCE_PRESENTATION = {
  related: { color: "positive" },
  unrelated: { color: "neutral-status" },
  uncertain: {
    color: "warning",
    glyph: { phosphor: "Question", sfSymbol: "questionmark.circle" },
  },
} satisfies Record<z.infer<typeof mailboxClassification>, OptionPresentation>;

const STATUS_PRESENTATION = {
  pending: { color: "warning" },
  researching: {
    color: "info",
    glyph: { phosphor: "MagnifyingGlass", sfSymbol: "magnifyingglass" },
  },
  completed: { color: "positive" },
  blocked: {
    color: "destructive",
    glyph: { phosphor: "WarningCircle", sfSymbol: "exclamationmark.circle" },
  },
  deleted: {
    color: "neutral-status",
    glyph: { phosphor: "Trash", sfSymbol: "trash" },
  },
  excluded: {
    color: "neutral-status",
    glyph: { phosphor: "MinusCircle", sfSymbol: "minus.circle" },
  },
} satisfies Record<z.infer<typeof emailStatus>, OptionPresentation>;

const readOnly = <T extends z.ZodTypeAny>(read: T) => ({
  read,
  create: null,
  update: null,
});
// `linkState` and link order are relative to one scope record.
const EMAIL_SCOPE_REASON =
  "Link state is relative to one Purchase, Vendor or Vendor account.";

const relevanceOptions = mailboxClassification.options.map((value) => ({
  value,
  label: MAILBOX_CLASSIFICATION_LABEL[value],
  ...RELEVANCE_PRESENTATION[value],
}));
const stageOptions = mailboxClassificationStage.options.map((value) => ({
  value,
  label: MAILBOX_CLASSIFICATION_STAGE_LABEL[value],
}));
const statusOptions = emailStatus.options.map((value) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
  ...STATUS_PRESENTATION[value],
}));

const linkStateOptions = [
  {
    value: "linked",
    label: EMAIL_LINK_STATE_LABEL["linked"],
    color: "positive",
  },
  {
    value: "suggested",
    label: EMAIL_LINK_STATE_LABEL["suggested"],
    color: "warning",
  },
  {
    value: "dismissed",
    label: EMAIL_LINK_STATE_LABEL["dismissed"],
    color: "neutral-status",
  },
  {
    value: "none",
    label: EMAIL_LINK_STATE_LABEL["none"],
    color: "neutral-status",
  },
] satisfies {
  value: string;
  label: string;
  color?: import("@cubby/shared/enum-palette").ColorToken;
  glyph?: import("@cubby/shared/enum-palette").EnumIcon;
}[];
const importOutcomeOptions = [
  {
    value: "imported",
    label: "Imported",
    color: "positive",
  },
  {
    value: "importing",
    label: "Importing",
    color: "info",
  },
  {
    value: "failed",
    label: "Import failed",
    color: "destructive",
  },
  {
    value: "not_imported",
    label: "Not imported",
    color: "neutral-status",
  },
] satisfies {
  value: string;
  label: string;
  color?: import("@cubby/shared/enum-palette").ColorToken;
  glyph?: import("@cubby/shared/enum-palette").EnumIcon;
}[];

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
    domain: "purchases",
    description: "Scanned mailbox messages, their Relevance and import status.",
    emptyState: {
      title: "No Emails yet",
      description: "Mail discovery records metadata for every scanned message.",
    },
    icons: { phosphor: "Envelope", sfSymbol: "envelope", emoji: "✉️" },
    detail: {
      summary: [
        {
          kind: "fields",
          id: "sender-received",
          title: "Sender & received",
          fields: ["sender", "receivedAt"],
        },
        {
          kind: "fields",
          id: "classification",
          title: "Classification",
          fields: ["classification"],
        },
        {
          kind: "fields",
          id: "review-import",
          title: "Review & import",
          fields: ["status", "importOutcome"],
        },
        {
          kind: "fields",
          id: "purchase-links",
          title: "Purchase links",
          fields: ["purchaseLinks"],
        },
        {
          kind: "records",
          id: "import-run",
          title: "Import Run",
          viewKey: "relation:run",
        },
      ],

      hero: {
        chip: "classification",

        when: { field: "receivedAt" },
      },
      additionalSections: [
        { kind: "slot", id: "review", title: "Review and import" },
      ],
    },
    list: {
      views: ["table"],
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
            "Emails whose latest rule, decision-model or relevance-model result disagrees with the member's review",
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
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: readOnly(shortcodeSchema("email")),
      },
      {
        display: { detail: false, list: false },
        key: "displayName",
        kind: "text",
        validation: readOnly(z.string().min(1)),
      },
      {
        key: "sender",
        kind: "text",
        nullable: true,
        display: { columnGroup: "Message" },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "subject",
        kind: "text",
        nullable: true,
        display: { listHidden: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "receivedAt",
        kind: "timestamp",
        nullable: true,
        labelOverride: "Received",
        display: { columnGroup: "Message", format: "timestamp" },
        validation: readOnly(z.date().nullable()),
      },
      {
        key: "classification",
        kind: "enum",
        nullable: true,
        labelOverride: "Relevance",
        control: { kind: "select", options: relevanceOptions },
        // The list cell names the deciding stage, e.g. "Uncertain · Rule".
        display: {
          columnGroup: "Review",
          labelPath: "relevanceLabel",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(mailboxClassification.nullable()),
      },
      labelField("relevanceLabel", "Relevance and its deciding stage"),
      {
        key: "classificationStage",
        kind: "enum",
        nullable: true,
        labelOverride: "Relevance stage",
        control: { kind: "select", options: stageOptions },
        display: {
          columnGroup: "Review",
          listHidden: true,
          optionRole: "category",
          optionColor: "domain-purchases",
          optionGlyph: { phosphor: "ListChecks", sfSymbol: "checklist" },
        },
        validation: readOnly(mailboxClassificationStage.nullable()),
      },
      {
        key: "classificationReason",
        kind: "text",
        nullable: true,
        labelOverride: "Relevance reason",
        display: { columnGroup: "Review", listHidden: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "reviewedClassification",
        kind: "enum",
        nullable: true,
        labelOverride: "Reviewed relevance",
        control: { kind: "select", options: relevanceOptions },
        display: {
          columnGroup: "Review",
          columnLabel: "Relevance",
          optionRole: "status",
          optionColor: "neutral-status",
        },
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
                "Latest rule, decision-model or relevance-model result disagrees with the member's resolution or review",
            },
          ],
        },
        display: { columnGroup: "Review", listHidden: true },
        validation: readOnly(z.boolean()),
      },
      {
        key: "reviewedClassificationReason",
        kind: "text",
        nullable: true,
        labelOverride: "Review reason",
        display: { list: false },
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
        display: {
          columnGroup: "Import",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(emailStatus),
      },
      {
        key: "mailboxId",
        kind: "text",
        labelOverride: "Mailbox",
        display: { columnGroup: "Message", listHidden: true },
        validation: readOnly(z.string()),
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        reference: { entity: "ledgerParty" },
        labelOverride: "Owner",
        display: { list: false, labelPath: "ledgerPartyName" },
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
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "messageId",
        kind: "text",
        labelOverride: "Provider message ID",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "threadId",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "historyId",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "checksum",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "classificationVersion",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "runId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "run" },
        labelOverride: "Processing Run",
        display: { list: false },
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
        display: { list: false },
        validation: readOnly(z.boolean()),
      },
      {
        key: "linkState",
        kind: "enum",
        labelOverride: "Link",
        control: { kind: "select", options: linkStateOptions },
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Strongest Purchase pair in the list's scope: accepted import sources and reviewed links, then live suggestions, then dismissals",
            },
          ],
        },
        display: {
          columnGroup: "Import",
          detail: false,
          listHidden: true,
          width: "sm",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(emailLinkState),
      },
      {
        key: "purchaseLinks",
        kind: "json",
        labelOverride: "Purchases",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Each related Purchase in the list's scope with its link state",
            },
          ],
        },
        // The Email page's Purchase links ledger shows these with actions.
        display: {
          columnGroup: "Import",
          detail: false,
          listHidden: true,
          labelPath: "purchaseLinks[].label",
          renderer: { list: "purchase-links" },
        },
        validation: readOnly(z.array(emailPurchaseLink)),
      },
      {
        display: { detail: false, list: false },
        key: "ownedByViewer",
        kind: "boolean",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "The signed-in member owns this Email; only the owner reviews, links or imports it",
            },
          ],
        },
        validation: readOnly(z.boolean()),
      },
      {
        key: "importOutcome",
        kind: "enum",
        labelOverride: "Import",
        control: { kind: "select", options: [...importOutcomeOptions] },
        provenance: {
          kind: "derived",
          sources: [
            { label: "Accepted import sources and the Email's import Run" },
          ],
        },
        display: {
          columnGroup: "Import",
          listHidden: true,
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(emailImportOutcome),
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { list: false },
        validation: readOnly(z.date()),
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false },
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
      "linkState",
      "purchaseLinks",
      "ownedByViewer",
      "importOutcome",
      "createdAt",
      "updatedAt",
    ],
    create: [],
    update: [],
    audit: [],
    derived: {
      // Linked, then suggested, then unlinked; newest first within one.
      linkState: { type: "enum", options: [...emailLinkState.options] },
      // The link state the list shows, relative to its scope record.
      scopeLinkState: { type: "enum", options: [...emailLinkState.options] },
      linked: { type: "boolean" },
      // The pipeline stage disagrees with a review decision.
      reviewConflict: { type: "boolean" },
      purchaseId: { predicate: "idMulti", reason: EMAIL_SCOPE_REASON },
      vendorId: { predicate: "idMulti", reason: EMAIL_SCOPE_REASON },
      vendorAccountId: { predicate: "idMulti", reason: EMAIL_SCOPE_REASON },
    },
    sort: {
      fields: [
        "receivedAt",
        "sender",
        "subject",
        "classification",
        "classificationStage",
        "status",
        "mailboxId",
        "linkState",
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
      {
        // An import claim's message key (`purchaseAssociatedEmailsSql`).
        name: "Email_source_key_idx",
        on: [
          "ledgerPartyId",
          { sql: "({provider} || ':' || {mailboxId} || ':' || {messageId})" },
        ],
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
        anyOf: ["sender"],
      },
      {
        columnId: "subject",
        kind: "text",
        placeholder: "Filter by subject...",
        deriveSchema: true,
        anyOf: ["subject"],
      },
      {
        columnId: "receivedAt",
        kind: "range",
        placeholder: "Filter by received date...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "classification",
        kind: "multiselect",
        placeholder: "Filter by Relevance...",
        deriveSchema: true,
        options: relevanceOptions,
      },
      {
        columnId: "classificationStage",
        kind: "multiselect",
        placeholder: "Filter by Relevance stage...",
        deriveSchema: true,
        options: stageOptions,
      },
      {
        columnId: "classificationReason",
        kind: "text",
        placeholder: "Filter by Relevance reason...",
        deriveSchema: true,
        anyOf: ["classificationReason"],
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        deriveSchema: true,
        options: statusOptions,
      },
      {
        columnId: "mailboxId",
        kind: "text",
        placeholder: "Filter by mailbox...",
        deriveSchema: true,
        anyOf: ["mailboxId"],
      },
      {
        columnId: "provider",
        kind: "text",
        placeholder: "Filter by provider...",
        deriveSchema: true,
        anyOf: ["provider"],
      },
      {
        columnId: "ledgerPartyId",
        kind: "idMulti",
        placeholder: "Filter by owner...",
        brandRef: { entity: "ledgerParty" },
        currentMember: true,
        deriveSchema: true,
      },
      {
        columnId: "runId",
        kind: "idMulti",
        placeholder: "Filter by Run...",
        brandRef: { entity: "run" },
        deriveSchema: true,
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
        columnId: "linkState",
        kind: "multiselect",
        derived: "scopeLinkState",
        placeholder: "Filter by link...",
        options: linkStateOptions,
      },
      {
        columnId: "purchaseId",
        label: "Purchase",
        kind: "idMulti",
        placeholder: "Emails for Purchase...",
        brandRef: { entity: "purchase" },
        singleValue: { reason: EMAIL_SCOPE_REASON, group: "emailScope" },
      },
      {
        columnId: "vendorId",
        label: "Vendor",
        kind: "idMulti",
        placeholder: "Emails for Vendor...",
        brandRef: { entity: "vendor" },
        singleValue: { reason: EMAIL_SCOPE_REASON, group: "emailScope" },
      },
      {
        columnId: "vendorAccountId",
        label: "Vendor account",
        kind: "idMulti",
        placeholder: "Emails for Vendor account...",
        brandRef: { entity: "vendorAccount" },
        singleValue: { reason: EMAIL_SCOPE_REASON, group: "emailScope" },
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
    merge: false,
    lifecycle: "readOnly",
    // Relevance-conditional Email pipeline gaps; an unrelated Email can only
    // lack a member review.
    dataQuality: {
      // Rows the stored evaluator reads beyond its own row (ADR 0021).
      inputs: [
        { table: "OrderMail", match: { id: "orderMailId" } },
        { table: "OrderMailAttachment", match: { orderMailId: "orderMailId" } },
        { table: "EmailCandidateObservation", match: { emailId: "id" } },
        { table: "EmailClassificationObservation", match: { emailId: "id" } },
        // A completed mail import names its originals in `input.sources`.
        {
          table: "Run",
          match: { input: "orderMailId" },
          json: { array: ["sources"], key: "orderMailId" },
          where: { purpose: "mail_import" },
          columns: ["status", "deletedAt", "input", "ledgerPartyId"],
        },
      ],
      checks: [
        {
          id: "email_relevance_undecided",
          satisfiedLabel: "Relevance classified",
          placement: { field: "classification" },
          facet: "content",
          weight: 3,
          label: "Relevance",
          message: "Relevance is uncertain.",
        },
        {
          id: "email_relevance_unreviewed",
          satisfiedLabel: "Member review complete",
          placement: { field: "reviewedClassification" },
          facet: "provenance",
          weight: 1,
          label: "Member review",
          message:
            "A rule, the decision model or the relevance model decided; no member review.",
        },
        {
          id: "email_original_missing",
          satisfiedLabel: "Original retained",
          placement: { section: "review" },
          facet: "integrity",
          weight: 2,
          label: "Original",
          message: "The original content is not retained.",
        },
        {
          id: "email_preview_missing",
          satisfiedLabel: "Extraction preview recorded",
          placement: { section: "review" },
          facet: "content",
          weight: 1,
          label: "Extraction preview",
          message: "No extraction preview for the current original.",
        },
        {
          id: "email_not_imported",
          satisfiedLabel: "Import complete",
          placement: { section: "review" },
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
      repository: {
        module: "~/server/domains/email/repo/email",
        export: "emailRepository",
      },
    },
  },
});

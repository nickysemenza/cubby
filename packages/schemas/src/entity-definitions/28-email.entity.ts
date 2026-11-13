import { defineEdge } from "./edges";
import { timestampField, readOnly } from "./field-policy";
import { withQuiet } from "./select-control-options.js";
import { emailRelationshipResult } from "../email-relationship-facts";
import { EMAIL_RELATIONSHIP_INPUTS } from "./email-relationship-inputs";
import type { ColorToken, EnumIcon } from "@cubby/shared/enum-palette";
import { z } from "zod";
import { dateTime } from "../codec";
import {
  EMAIL_IMPORT_OUTCOME_LABEL,
  EMAIL_LINK_STATE_LABEL,
  emailImportOutcome,
  emailImportOutcomeDetail,
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
import { defineEntity, defineEntityModel } from "./definition.js";
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
  unsettled: {
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
const IMPORT_OUTCOME_PRESENTATION = {
  imported: { color: "positive" },
  linked: { color: "positive" },
  waiting: { color: "info" },
  needs_research: {
    color: "warning",
    glyph: { phosphor: "MagnifyingGlass", sfSymbol: "magnifyingglass" },
  },
  needs_member: {
    color: "warning",
    glyph: { phosphor: "WarningCircle", sfSymbol: "exclamationmark.circle" },
  },
  importing: { color: "info" },
  failed: { color: "destructive" },
  unrelated: { color: "neutral-status" },
  not_imported: { color: "neutral-status" },
} satisfies Record<z.infer<typeof emailImportOutcome>, OptionPresentation>;
const importOutcomeOptions = emailImportOutcome.options.map((value) => ({
  value,
  label: EMAIL_IMPORT_OUTCOME_LABEL[value],
  ...IMPORT_OUTCOME_PRESENTATION[value],
}));

/**
 * The promoted processing ledger owns identity and headers; retained content is optional.
 * @public The shortcode registry generator parses this module's `definition` and `readSchemas`.
 */
export const { definition, readSchemas } = defineEntityModel({
  key: "email",
  edges: [
    defineEdge({
      key: "ShipmentSourceCapture.emailId",
      from: "row:ShipmentSourceCapture",
      to: "email",
      cardinality: "one",
      inverse: {
        key: "email.incoming.ShipmentSourceCapture.emailId",
        from: "email",
        to: "row:ShipmentSourceCapture",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "ShipmentSourceCapture.emailId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason:
          "Workflow evidence about entities, not a relationship between them.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "shipment source captures",
        description: "Retained reference to the original shipping Email.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Shipment provenance retains the Email identity after its removal.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "EmailCandidateObservation.emailId",
      from: "row:EmailCandidateObservation",
      to: "email",
      cardinality: "one",
      inverse: {
        key: "email.incoming.EmailCandidateObservation.emailId",
        from: "email",
        to: "row:EmailCandidateObservation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EmailCandidateObservation.emailId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable Email candidate history.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "candidate observations",
        description:
          "Immutable evidence about the original Email, retained through its tombstone.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "EmailClassificationObservation.emailId",
      from: "row:EmailClassificationObservation",
      to: "email",
      cardinality: "one",
      inverse: {
        key: "email.incoming.EmailClassificationObservation.emailId",
        from: "email",
        to: "row:EmailClassificationObservation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EmailClassificationObservation.emailId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable Email classification history.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "classification observations",
        description:
          "Immutable evidence about the original Email, retained through its tombstone.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "EmailFinancialAssociation.emailId",
      from: "row:EmailFinancialAssociation",
      to: "email",
      cardinality: "one",
      inverse: {
        key: "email.incoming.EmailFinancialAssociation.emailId",
        from: "email",
        to: "row:EmailFinancialAssociation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EmailFinancialAssociation.emailId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "EmailFinancialAssociation.emailId",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "financial associations",
        description:
          "A member-reviewed link from this Email's evidence to a settlement transaction, retained through its tombstone.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "A reviewed Email-to-transaction association is append-only history that keeps its original UUIDs through every tombstone.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "EmailRetrievalFailure.emailId",
      from: "row:EmailRetrievalFailure",
      to: "email",
      cardinality: "one",
      inverse: {
        key: "email.incoming.EmailRetrievalFailure.emailId",
        from: "email",
        to: "row:EmailRetrievalFailure",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EmailRetrievalFailure.emailId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Immutable Email retrieval history.",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "history",
        label: "retrieval failures",
        description:
          "Immutable evidence about the original Email, retained through its tombstone.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
  ],

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
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: [
            "sender",
            "subject",
            "receivedAt",
            "classification",
            "classificationStage",
            "classificationReason",
            "reviewedClassification",
            "reviewConflict",
            "reviewedClassificationReason",
            "status",
            "mailboxId",
            "ledgerPartyId",
            "provider",
            "messageId",
            "threadId",
            "historyId",
            "checksum",
            "classificationVersion",
            "runId",
            "linked",
            "importOutcome",
            "createdAt",
            "updatedAt",
          ],
        },
        { kind: "slot", id: "review", title: "Review and import" },
      ],
    },
    list: {
      rail: [{ field: "receivedAt" }],
      views: ["table"],
      links: [{ label: "Mail coverage", path: "/emails/coverage" }],
      savedViews: [
        {
          id: "pipeline-worklist",
          label: "Needs attention",
          description:
            "Emails whose Relevance, original, preview or import is incomplete, most missing first",
          filters: [
            {
              id: "dataGaps",
              value: [
                "email_relevance_undecided",
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
        display: {
          mobile: { slot: "subtitle", priority: 10 },
          columnGroup: "Message",
        },
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
        label: "Received",
        display: { columnGroup: "Message", format: "timestamp" },
        validation: readOnly(dateTime.nullable()),
      },
      {
        key: "classification",
        kind: "enum",
        nullable: true,
        label: "Relevance",
        control: { kind: "select", options: relevanceOptions },
        // The list cell names the deciding stage, e.g. "Uncertain · Rule".
        display: {
          mobile: { slot: "meta", priority: 30 },
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
        label: "Relevance stage",
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
        label: "Relevance reason",
        display: { columnGroup: "Review", listHidden: true },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "reviewedClassification",
        kind: "enum",
        nullable: true,
        label: "Reviewed relevance",
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
        label: "Review reason",
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
        control: {
          kind: "select",
          options: withQuiet(statusOptions, "completed"),
        },
        display: {
          mobile: { slot: "meta", priority: 20 },
          columnGroup: "Import",
          optionRole: "status",
          optionColor: "neutral-status",
        },
        validation: readOnly(emailStatus),
      },
      {
        key: "mailboxId",
        kind: "text",
        label: "Mailbox",
        display: { columnGroup: "Message", listHidden: true },
        validation: readOnly(z.string()),
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        reference: { entity: "ledgerParty" },
        label: "Owner",
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
        label: "Provider message ID",
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
        label: "Processing Run",
        display: { list: false },
        validation: readOnly(runShortcode.nullable()),
      },
      {
        key: "linked",
        storedKey: "relationshipFacts",
        storedPath: ["linked"],
        storedProjection: true,
        kind: "boolean",
        explanation: {
          ruleId: "email.purchase-association",
          description:
            "Accepted import sources or reviewed links associate this Email with a live Purchase. Current account ownership gates the published candidate facts; suggestions and dismissals alone are not associations.",
          sourceDependencies: [
            {
              path: "storedResult.evidence",
              label: "Published facts before current account-owner gates",
            },
          ],
        },
        provenance: {
          kind: "derived",
          sources: [
            { label: "Accepted import sources and active lifecycle links" },
          ],
        },
        display: { list: false },
        validation: readOnly(z.boolean().nullable()),
      },
      {
        key: "linkState",
        explanation: {
          ruleId: "email.linkState",
          scopeFilters: {
            purchase: "purchaseId",
            vendor: "vendorId",
            vendorAccount: "vendorAccountId",
          },
          description:
            "The strongest eligible Purchase pair in the requested list scope determines this state. All eligible pairs are folded before narrowing the scope so replacement warnings remain visible.",
          sourceDependencies: [
            {
              path: "storedResult.evidence",
              label:
                "Published unscoped facts before current eligibility and scope",
            },
          ],
        },
        storedKey: "relationshipFacts",
        storedPath: ["linkState"],
        storedProjection: true,
        kind: "enum",
        label: "Link",
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
        validation: readOnly(emailLinkState.nullable()),
      },
      {
        key: "purchaseLinks",
        explanation: {
          ruleId: "email.purchaseLinks",
          scopeFilters: {
            purchase: "purchaseId",
            vendor: "vendorId",
            vendorAccount: "vendorAccountId",
          },
          description:
            "Published relationship facts are folded with current Purchase and account-owner eligibility, then narrowed to the requested list scope. Replacement warnings retain evidence from the complete eligible set.",
          sourceDependencies: [
            {
              path: "storedResult.evidence",
              label:
                "Published unscoped facts before current eligibility and scope",
            },
          ],
        },
        storedKey: "relationshipFacts",
        storedPath: ["purchaseLinks"],
        storedProjection: true,
        kind: "json",
        label: "Purchases",
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
        validation: readOnly(z.array(emailPurchaseLink).nullable()),
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
        storedKey: "relationshipFacts",
        storedProjection: true,
        kind: "enum",
        label: "Import",
        control: { kind: "select", options: [...importOutcomeOptions] },
        explanation: {
          ruleId: "email.import-outcome",
          description:
            "Accepted import source facts mean Imported. Otherwise the newest import outcome recorded for the Email's current checksum decides: Linked, Unrelated, or an unresolved gap routed by who settles it (Waiting when Cubby re-runs it by itself, Needs research for an agent, Needs you for the member). Without an outcome, the holding Run supplies Importing while it runs and Import failed once it ended. No Run, outcome or source means Not imported only when published facts confirm no accepted source; otherwise the outcome remains unavailable.",
          sourceDependencies: [
            {
              path: "storedResult.evidence",
              label: "Published facts before current account-owner gates",
            },
            {
              path: "runId",
              label: "Current import Run",
            },
          ],
        },
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Accepted import sources, the newest import outcome and the Email's import Run",
            },
          ],
        },
        display: {
          columnGroup: "Import",
          width: "sm",
          optionRole: "status",
          optionColor: "neutral-status",
          renderer: { detail: "email-import-outcome" },
        },
        validation: readOnly(emailImportOutcome.nullable()),
      },
      {
        key: "importOutcomeDetail",
        kind: "json",
        label: "Import detail",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "The import outcome with its gap category, who settles it, its reason, the source it waits on and its Run",
            },
          ],
        },
        display: { list: false, detail: false },
        validation: readOnly(emailImportOutcomeDetail.nullable()),
      },
      timestampField("createdAt"),
      timestampField("updatedAt"),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      { key: "id", specialized: "primary-key:EmailId" },
      { key: "shortcode", specialized: "shortcode" },
      "ledgerPartyId",
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
      "runId",
      "createdAt",
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

    stored: {
      relationshipFacts: {
        compute: "email.relationshipFacts",
        snapshotSource: {
          table: "EmailReadSnapshot",
          value: "relationshipFacts",
          computedAt: "relationshipFactsComputedAt",
          decidedBy: "relationshipFactsDecision",
          storage: "json",
          sort: "relationshipFactsSort",
        },
        publishes: "derivedValue",
        resultSchema: emailRelationshipResult,
        inputs: EMAIL_RELATIONSHIP_INPUTS,
      },
    },
    rows: {
      coverageCandidates: {
        label: "Mail coverage",
        repository: { vendor: { reference: "vendor" }, stage: "text" },
      },
    },
    derived: {
      coverageVendorId: { via: "coverageCandidates.vendor" },
      coverageStage: { via: "coverageCandidates.stage" },
      // Linked, then suggested, then unlinked; newest first within one.
      linkState: { type: "enum", options: [...emailLinkState.options] },
      // The link state the list shows, relative to its scope record.
      scopeLinkState: {
        type: "enum",
        options: [...emailLinkState.options],
        requiresResult: "relationshipFacts",
      },
      linked: { type: "boolean", requiresResult: "relationshipFacts" },
      // The pipeline stage disagrees with a review decision.
      reviewConflict: { type: "boolean" },
      importOutcome: { type: "enum", options: [...emailImportOutcome.options] },
      purchaseId: {
        predicate: "idMulti",
        reason: EMAIL_SCOPE_REASON,
        requiresResult: "relationshipFacts",
      },
      vendorId: {
        predicate: "idMulti",
        reason: EMAIL_SCOPE_REASON,
        requiresResult: "relationshipFacts",
      },
      vendorAccountId: {
        predicate: "idMulti",
        reason: EMAIL_SCOPE_REASON,
        requiresResult: "relationshipFacts",
      },
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
      // Exact-linking keys from the retained content whose checksum is
      // `mailKeysChecksum`; null or stale keys are recomputed at claim time.
      {
        key: "orderKeys",
        kind: "json",
        type: {
          module: "@cubby/schemas/email-fields",
          export: "EmailOrderKeys",
        },
      },
      {
        key: "trackingKeys",
        kind: "json",
        type: {
          module: "@cubby/schemas/email-fields",
          export: "EmailTrackingKeys",
        },
      },
      { key: "mailKeysChecksum", kind: "text" },
      // Admissions of the current checksum; bounds automatic re-admission.
      {
        key: "importAttempts",
        kind: "json",
        type: {
          module: "@cubby/schemas/email-fields",
          export: "EmailImportAttempts",
        },
      },
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
      {
        on: ["orderMailId"],
        unique: true,
        where: "{orderMailId} IS NOT NULL",
      },
      { on: ["ledgerPartyId", { column: "receivedAt", desc: true }] },
      {
        // Page-scoped sender attribution (`readSenderAttributions`) filters on
        // this exact normalized address; keep the expression textually equal.
        name: "Email_sender_address_idx",
        on: [
          {
            sql: "lower(trim(coalesce(substring({sender} from '<([^>]+)>'), {sender})))",
          },
        ],
        where: "{deletedAt} IS NULL",
      },
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
        columnId: "coverageVendorId",
        label: "Coverage Vendor",
        kind: "idMulti",
        placeholder: "Candidates or evidence for Vendor...",
        brandRef: { entity: "vendor" },
        singleValue: { reason: "One Mail coverage row" },
      },
      {
        columnId: "coverageStage",
        kind: "multiselect",
        placeholder: "Coverage stage...",
        options: [
          { value: "known", label: "Known Emails" },
          { value: "classified", label: "Classified Emails" },
          { value: "retained", label: "Content saved" },
          { value: "linked", label: "Linked Emails" },
        ],
      },
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
        columnId: "createdAt",
        label: "Created",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter by created date...",
      },
      {
        columnId: "updatedAt",
        label: "Updated",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter by updated date...",
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
        columnId: "importOutcome",
        label: "Import",
        kind: "multiselect",
        placeholder: "Filter by import...",
        deriveSchema: true,
        options: importOutcomeOptions,
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
        {
          table: "Purchase",
          match: { id: "id" },
          columns: ["vendorAccountId", "deletedAt"],
          path: [
            {
              table: "EmailPurchaseDecision",
              from: "purchaseId",
              to: "eventId",
            },
            { table: "OrderMailEvent", from: "id", to: "orderMailId" },
            { table: "Email", from: "orderMailId", to: "id" },
          ],
        },
        {
          table: "VendorAccount",
          match: { id: "id" },
          columns: ["ledgerPartyId", "deletedAt"],
          path: [
            { table: "Purchase", from: "vendorAccountId", to: "id" },
            {
              table: "EmailPurchaseDecision",
              from: "purchaseId",
              to: "eventId",
            },
            { table: "OrderMailEvent", from: "id", to: "orderMailId" },
            { table: "Email", from: "orderMailId", to: "id" },
          ],
        },

        {
          table: "EmailPurchaseDecision",
          match: { eventId: "orderMailId" },
          path: [{ table: "OrderMailEvent", from: "id", to: "orderMailId" }],
        },

        {
          table: "ImportSourceClaim",
          match: { ledgerPartyId: "ledgerPartyId" },
        },
        { table: "LedgerParty", match: { id: "ledgerPartyId" } },
        {
          table: "ImportSourceOrder",
          match: { sourceClaimId: "id" },
          path: [
            { table: "ImportSourceClaim", from: "id", to: "ledgerPartyId" },
            { table: "Email", from: "ledgerPartyId", to: "id" },
          ],
        },
        { table: "OrderMailEvent", match: { orderMailId: "orderMailId" } },
        {
          table: "Purchase",
          match: { id: "id" },
          path: [
            {
              table: "ImportSourceOrder",
              from: "purchaseId",
              to: "sourceClaimId",
            },
            { table: "ImportSourceClaim", from: "id", to: "ledgerPartyId" },
            { table: "Email", from: "ledgerPartyId", to: "id" },
          ],
        },
        {
          table: "VendorAccount",
          match: { id: "id" },
          path: [
            { table: "Purchase", from: "vendorAccountId", to: "id" },
            {
              table: "ImportSourceOrder",
              from: "purchaseId",
              to: "sourceClaimId",
            },
            { table: "ImportSourceClaim", from: "id", to: "ledgerPartyId" },
            { table: "Email", from: "ledgerPartyId", to: "id" },
          ],
        },
        // Retired captures keep their positions, so pending tickets still expand.
        {
          table: "Suggestion",
          capture: false,
          match: { subject: "id" },
          json: { key: "recordId" },
          where: { family: "email_relevance" },
        },
        {
          table: "Suggestion",
          capture: false,
          match: { id: "id" },
          path: [
            {
              table: "Suggestion",
              from: "id",
              to: "subject",
              jsonKey: "recordId",
              where: { family: "email_relevance" },
            },
          ],
        },

        { table: "OrderMail", match: { id: "orderMailId" } },
        {
          table: "OrderMailAttachment",
          match: { orderMailId: "orderMailId" },
        },
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
        // Appended: a member's review is an Email quality input.
        { table: "EmailReview", match: { emailId: "id" } },
      ],
      checks: [
        {
          id: "email_relevance_undecided",
          satisfiedLabel: "Relevance classified",
          placement: { field: "classification" },
          facet: "content",
          label: "Relevance",
          message: "Relevance is uncertain.",
        },
        {
          id: "email_original_missing",
          satisfiedLabel: "Original retained",
          placement: { section: "review" },
          facet: "integrity",
          label: "Original",
          message: "The original content is not retained.",
        },
        {
          id: "email_preview_missing",
          satisfiedLabel: "Extraction preview recorded",
          placement: { section: "review" },
          facet: "content",
          label: "Extraction preview",
          message: "No extraction preview for the current original.",
        },
        {
          id: "email_not_imported",
          satisfiedLabel: "Import complete",
          placement: { section: "review" },
          facet: "linkage",
          label: "Import",
          message: "No associated Purchase or completed import Run.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      reports: {
        module: "~/server/domains/email/repo/report-bindings",
        export: "reportBindings",
      },
      fieldEnvelope: {
        module: "~/server/domains/email/repo/field-envelope",
        export: "projectEmailFieldEnvelopes",
      },
      repository: {
        module: "~/server/domains/email/repo/email",
        export: "emailRepository",
      },
    },
  },
});

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r
          .query("reviewedEmailTransactions", "many")
          .named("reviewed-transactions", "Reviewed transaction evidence"),
        "financialTransaction.email.reviewed-transactions",
      ),
      r.declare(
        r
          .query("reviewedEmailAccounts", "many")
          .named("reviewed-accounts", "Account at review"),
        "financialAccount.email.reviewed-accounts",
      ),
      r.declare(
        r.field("ledgerPartyId").named("ledger-party", "Owner"),
        "ledgerParty.emails",
      ),
      r.declare(
        r.field("runId").named("run", "Current import Run"),
        "run.emails",
      ),
    ],
  }),
  readSchemas,
);

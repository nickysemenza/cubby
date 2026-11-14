import { defineEdge } from "./edges";
import { sourceIdentityResolution } from "../source-occurrence-fields";
import { readOnly, timestampField } from "./field-policy";
import { capitalize } from "@cubby/shared/text-case";
import { z } from "zod";
import { dateTime } from "../codec";
import { defineEntity, defineEntityModel } from "./definition.js";
import { plainDate } from "../base-entity";
import { shortcodeSchema } from "../identifier-fields";
import { merchantVendorInference } from "../financial-transaction-fields";
import {
  sourceTransactionRecordDisposition,
  sourceTransactionRecordDispositionReason,
  sourceTransactionRecordProviderStatus,
  sourceTransactionRecordMatchState,
} from "../source-transaction-record-fields";
export const { definition, readSchemas } = defineEntityModel({
  key: "sourceTransactionRecord",
  edges: [
    defineEdge({
      key: "SourceOccurrence.currentObservationId",
      from: "sourceOccurrence",
      to: "sourceTransactionRecord",
      cardinality: "one",
      inverse: {
        key: "sourceTransactionRecord.incoming.SourceOccurrence.currentObservationId",
        from: "sourceTransactionRecord",
        to: "sourceOccurrence",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceOccurrence.currentObservationId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "sourceOccurrence",
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
        label: "occurrence frontier",
        description:
          "Retain the selected frontier after observation deletion; never promote an older version.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "A tombstoned frontier reserves source identity without authorizing automatic money.",
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
            kind: "disposition",
            disposition: {
              code: "retain-occurrence-head",
              effect: "preserve",
              description:
                "Occurrence head evidence remains reserved through an observation tombstone.",
            },
            handler: null,
            before: {
              module:
                "~/server/domains/transaction-import/repo/source-transaction-record-lifecycle",
              export: "assertSourceTransactionRecordDeletionAllowed",
            },
            beforeLock: {
              module:
                "~/server/domains/transaction-import/repo/source-transaction-record-lifecycle",
              export: "lockSourceObservationRemoval",
            },
            order: 0,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "SourceOccurrence.replacementObservationId",
      from: "sourceOccurrence",
      to: "sourceTransactionRecord",
      cardinality: "one",
      inverse: {
        key: "sourceTransactionRecord.incoming.SourceOccurrence.replacementObservationId",
        from: "sourceTransactionRecord",
        to: "sourceOccurrence",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceOccurrence.replacementObservationId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "sourceOccurrence",
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
        label: "replacement proof",
        description:
          "The exact reviewed replacement observation remains explainable.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "The deletion hook protects live replacement decisions while history remains retained.",
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
            kind: "disposition",
            disposition: {
              code: "retain-replacement-proof",
              effect: "block",
              description:
                "A live explicit replacement decision requires its exact observation evidence.",
            },
            handler: null,
            order: 1,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "SourceObservationAnnotation.supersededByObservationId",
      from: "row:SourceObservationAnnotation",
      to: "sourceTransactionRecord",
      cardinality: "one",
      inverse: {
        key: "sourceTransactionRecord.incoming.SourceObservationAnnotation.supersededByObservationId",
        from: "sourceTransactionRecord",
        to: "row:SourceObservationAnnotation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceObservationAnnotation.supersededByObservationId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "SourceObservationAnnotation.observationId",
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
        label: "original replacements",
        description:
          "Each original observation preserves its reviewed successor.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "The live replacement guard owns deletion eligibility; retained decisions remain historical evidence.",
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
            kind: "disposition",
            disposition: {
              code: "retain-replacement-history",
              effect: "block",
              description:
                "A live predecessor retains its exact reviewed replacement observation.",
            },
            handler: null,
            order: 3,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "SourceObservationAnnotation.observationId",
      from: "row:SourceObservationAnnotation",
      to: "sourceTransactionRecord",
      cardinality: "one",
      inverse: {
        key: "sourceTransactionRecord.incoming.SourceObservationAnnotation.observationId",
        from: "sourceTransactionRecord",
        to: "row:SourceObservationAnnotation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceObservationAnnotation.observationId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "SourceObservationAnnotation.observationId",
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
        label: "observation annotations",
        description:
          "Original notes and unresolved judgments survive observation retirement.",
        liveness: {
          kind: "allow-target-deleted",
          reason: "Annotations preserve source history through its tombstone.",
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
            kind: "disposition",
            disposition: {
              code: "retain-observation-judgments",
              effect: "preserve",
              description:
                "Observation annotations and unresolved decisions remain retained.",
            },
            handler: null,
            order: 2,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "FinancialEvidenceAlias.observationId",
      from: "row:FinancialEvidenceAlias",
      to: "sourceTransactionRecord",
      cardinality: "one",
      inverse: {
        key: "sourceTransactionRecord.incoming.FinancialEvidenceAlias.observationId",
        from: "sourceTransactionRecord",
        to: "row:FinancialEvidenceAlias",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "FinancialEvidenceAlias.observationId",
        constrained: true,
      },
      ownership: {
        kind: "excluded",
        reason: "Retained financial provenance, never current ownership.",
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
        label: "retained evidence aliases",
        description:
          "Original aliases remain explainable through observation tombstones.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Alias evidence is retained, never a live accepted-owner lookup.",
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
            kind: "disposition",
            disposition: {
              code: "retain-source-aliases",
              effect: "preserve",
              description:
                "Original aliases remain explainable through observation tombstones.",
            },
            handler: null,
            order: 4,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
    defineEdge({
      key: "TransactionImportRecord.statementRowId",
      from: "row:TransactionImportRecord",
      to: "sourceTransactionRecord",
      cardinality: "one",
      inverse: {
        key: "sourceTransactionRecord.incoming.TransactionImportRecord.statementRowId",
        from: "sourceTransactionRecord",
        to: "row:TransactionImportRecord",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "TransactionImportRecord.statementRowId",
        constrained: true,
      },
      ownership: {
        kind: "column",
        column: "TransactionImportRecord.importId",
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
        label: "import memberships",
        description:
          "The imports that received this immutable source observation.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Intake history retains the original record identity through deletion.",
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
            kind: "disposition",
            disposition: {
              code: "retain-import-membership",
              effect: "preserve",
              description:
                "Imports retain original and subsequent memberships.",
            },
            handler: null,
            order: 5,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
  ],

  names: {
    singular: "Source transaction record",
    plural: "Source transaction records",
  },
  table: "SourceTransactionRecord",
  identifiers: { brand: "SourceTransactionRecordId", shortcode: "STR-" },
  route: { basePath: "source-transaction-records" },
  presentation: {
    searchFacts: ["statementDate", "amount"],
    titleField: "displayName",
    domain: "finance",
    description: "One retained version of a source-reported transaction.",
    // Retained source versions; members review the reconciled transactions.
    nativeBrowse: false,
    emptyState: {
      title: "No source transaction records yet",
      description: "Record financial evidence through the intake workflow.",
    },
    icons: { phosphor: "Receipt", sfSymbol: "doc.text", emoji: "🧾" },
    list: {
      rail: [{ field: "amount", sub: "statementDate" }],
      savedViews: [
        {
          id: "unmatched",
          label: "Unmatched",
          description: "Source records without accepted transaction evidence",
          filters: [{ id: "matchState", value: ["unmatched"] }],
        },
        {
          id: "superseded",
          label: "Superseded",
          description: "Records explicitly superseded during reconciliation",
          filters: [{ id: "matchState", value: ["superseded"] }],
        },
      ],
    },
    detail: {
      summary: [
        {
          kind: "fields",
          id: "observed-amount-date",
          title: "Observed amount & date",
          fields: ["amount", "statementDate"],
        },
        {
          kind: "records",
          id: "account",
          title: "Account",
          viewKey: "relation:account",
        },
        {
          kind: "fields",
          id: "match-disposition",
          title: "Match & disposition",
          fields: ["matchState", "disposition"],
        },
        {
          kind: "fields",
          id: "canonical-transaction",
          title: "Canonical transaction",
          fields: ["transactionId"],
        },
        {
          kind: "records",
          id: "revision-successor",
          title: "Revision successor",
          viewKey: "relation:supersededByRecord",
        },
        {
          kind: "records",
          id: "import-provenance",
          title: "Import provenance",
          viewKey: "relation:firstImport",
        },
      ],
      sections: [
        {
          kind: "fields",
          id: "reconciliation",
          title: "Reconciliation",
          fields: [
            "accountId",
            "disposition",
            "dispositionNote",
            "dispositionReason",
            "notes",
            "supersededByRowId",
          ],
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: [
            "id",
            "displayName",
            "occurrenceId",
            "factFingerprint",
            "batchId",
            "source",
            "externalId",
            "rowPosition",
            "providerTransactionId",
            "legacyExternalId",
            "chargeKey",
            "current",
            "withdrawnAt",
            "withdrawalImportId",
            "lastObservedAt",
            "providerAccountId",
            "accountDescriptor",
            "statementDate",
            "amount",
            "providerAmount",
            "merchant",
            "rawDescription",
            "sourceCategory",
            "providerStatus",
            "providerNotes",
            "createdAt",
            "updatedAt",
            "importFingerprint",
            "supersededBy",
            "matchState",
            "transactionId",
            "historicalTransactionIds",
            "vendorInference",
          ],
        },
      ],
    },
    edit: {
      sections: [
        {
          id: "judgments",
          title: "Reconciliation",
          fields: [
            "accountId",
            "disposition",
            "dispositionNote",
            "dispositionReason",
            "notes",
            "supersededByRowId",
          ],
        },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "identityResolution",
        kind: "json",
        output: false,
        audit: false,
        validation: {
          read: null,
          create: null,
          update: sourceIdentityResolution.optional(),
        },
      },
      {
        key: "occurrenceId",
        kind: "identifier",
        reference: { entity: "sourceOccurrence" },
        display: { list: false },
        validation: {
          read: shortcodeSchema("sourceOccurrence"),
          create: null,
          update: null,
        },
      },
      {
        key: "factFingerprint",
        kind: "text",
        display: { list: false },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "id",
        kind: "identifier",
        display: { list: false },
        validation: readOnly(shortcodeSchema("sourceTransactionRecord")),
      },
      {
        key: "displayName",
        provenance: {
          kind: "derived",
          sources: [{ label: "Source description, merchant and account" }],
        },
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string().min(1)),
      },
      {
        audit: true,
        key: "batchId",
        kind: "identifier",
        label: "First import",
        reference: { entity: "transactionImport" },
        display: { columnGroup: "Source" },
        validation: readOnly(shortcodeSchema("transactionImport")),
      },
      {
        audit: true,
        key: "source",
        kind: "text",
        display: { columnGroup: "Source" },
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "externalId",
        provenance: {
          kind: "derived",
          sources: [{ label: "Retained financial evidence alias" }],
        },
        kind: "text",
        label: "Source reference",
        display: { columnGroup: "Source" },
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "rowPosition",
        kind: "number",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.number().int().nullable()),
      },
      {
        audit: true,
        key: "providerTransactionId",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        audit: true,
        key: "legacyExternalId",
        provenance: {
          kind: "derived",
          sources: [{ label: "Retained financial evidence alias" }],
        },
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        output: false,
        audit: true,
        key: "legacyReference",
        kind: "text",
        nullable: true,
        validation: readOnly(z.string().nullable()),
      },
      {
        audit: true,
        key: "chargeKey",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Explicit source occurrence or retained unresolved observation decision",
            },
          ],
        },
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "current",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Explicit source occurrence or retained unresolved observation decision",
            },
          ],
        },
        kind: "boolean",
        display: { columnGroup: "Disposition" },
        validation: readOnly(z.boolean()),
      },
      {
        audit: true,
        key: "withdrawnAt",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Explicit source occurrence or retained unresolved observation decision",
            },
          ],
        },
        kind: "timestamp",
        nullable: true,
        display: { columnGroup: "Disposition", format: "timestamp" },
        validation: readOnly(dateTime.nullable()),
      },
      {
        audit: true,
        key: "withdrawalImportId",
        kind: "identifier",
        nullable: true,
        label: "Withdrawal proof",
        reference: { entity: "transactionImport" },
        display: { columnGroup: "Disposition" },
        validation: readOnly(shortcodeSchema("transactionImport").nullable()),
      },
      {
        audit: true,
        key: "lastObservedAt",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Explicit source occurrence or retained unresolved observation decision",
            },
          ],
        },
        kind: "timestamp",
        label: "Last observed",
        display: { list: false, format: "timestamp" },
        validation: readOnly(dateTime),
      },
      {
        audit: true,
        key: "providerAccountId",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        audit: true,
        key: "providerData",
        kind: "json",
        nullable: true,
        label: "Source metadata",
        display: {},
        validation: readOnly(z.json().nullable()),
      },
      {
        audit: true,
        key: "accountDescriptor",
        kind: "text",
        display: { columnGroup: "Source" },
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "statementDate",
        kind: "date",
        label: "Source date",
        display: { columnGroup: "Source" },
        validation: readOnly(plainDate),
      },
      {
        audit: true,
        key: "amount",
        kind: "number",
        display: {
          columnGroup: "Source",
          columnBar: true,
          format: "currency",
        },
        validation: readOnly(z.number()),
      },
      {
        audit: true,
        key: "providerAmount",
        kind: "number",
        label: "Original signed amount",
        display: { columnGroup: "Source", format: "currency" },
        validation: readOnly(z.number()),
      },
      {
        audit: true,
        key: "merchant",
        kind: "text",
        nullable: true,
        display: {
          mobile: { slot: "subtitle", priority: 10 },
          columnGroup: "Source",
        },
        validation: readOnly(z.string().nullable()),
      },
      {
        audit: true,
        key: "rawDescription",
        kind: "text",
        display: { columnGroup: "Source" },
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "sourceCategory",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        audit: true,
        key: "providerStatus",
        kind: "enum",
        nullable: true,
        display: {
          columnGroup: "Source",
          optionRole: "status",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Info", sfSymbol: "info.circle" },
        },
        control: {
          kind: "select",
          options: sourceTransactionRecordProviderStatus.options.map(
            (value) => ({
              value,
              label: capitalize(value.replaceAll("_", " ")),
              color: "neutral-status",
              glyph: { phosphor: "Info", sfSymbol: "info.circle" },
            }),
          ),
        },
        validation: readOnly(sourceTransactionRecordProviderStatus.nullable()),
      },
      {
        audit: true,
        key: "providerNotes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "accountId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "financialAccount" },
        display: {
          mobile: { slot: "meta", priority: 20 },
          columnGroup: "Reconciliation",
          labelPath: "accountName",
        },
        validation: {
          read: shortcodeSchema("financialAccount").nullable(),
          create: null,
          update: shortcodeSchema("financialAccount").nullable().optional(),
        },
      },
      {
        key: "disposition",
        provenance: {
          kind: "relation",
          sources: [
            {
              label: "Current bank-record group decision",
            },
          ],
        },
        kind: "enum",
        display: {
          columnGroup: "Disposition",
          optionRole: "status",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Info", sfSymbol: "info.circle" },
        },
        control: {
          kind: "select",
          options: sourceTransactionRecordDisposition.options.map((value) => ({
            value,
            label: capitalize(value.replaceAll("_", " ")),
            color: "neutral-status",
            glyph: { phosphor: "Info", sfSymbol: "info.circle" },
          })),
        },
        validation: {
          read: sourceTransactionRecordDisposition,
          create: null,
          update: sourceTransactionRecordDisposition.optional(),
        },
      },
      {
        key: "dispositionReason",
        provenance: {
          kind: "relation",
          sources: [
            {
              label: "Current bank-record group decision",
            },
          ],
        },
        kind: "enum",
        nullable: true,
        display: {
          columnGroup: "Disposition",
          optionRole: "status",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Info", sfSymbol: "info.circle" },
        },
        control: {
          kind: "select",
          options: sourceTransactionRecordDispositionReason.options.map(
            (value) => ({
              value,
              label: capitalize(value.replaceAll("_", " ")),
              color: "neutral-status",
              glyph: { phosphor: "Info", sfSymbol: "info.circle" },
            }),
          ),
        },
        validation: {
          read: sourceTransactionRecordDispositionReason.nullable(),
          create: null,
          update: sourceTransactionRecordDispositionReason
            .nullable()
            .optional(),
        },
      },
      {
        key: "dispositionNote",
        provenance: {
          kind: "relation",
          sources: [
            {
              label: "Current bank-record group decision",
            },
          ],
        },
        kind: "text",
        nullable: true,
        display: { list: false },
        control: { kind: "textarea" },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "supersededByRowId",
        kind: "identifier",
        nullable: true,
        label: "Superseded by",
        reference: { entity: "sourceTransactionRecord" },
        display: { columnGroup: "Disposition" },
        validation: {
          read: shortcodeSchema("sourceTransactionRecord").nullable(),
          create: null,
          update: shortcodeSchema("sourceTransactionRecord")
            .nullable()
            .optional(),
        },
      },
      {
        key: "notes",
        provenance: {
          kind: "relation",
          sources: [
            {
              label: "Current bank-record group decision",
            },
          ],
        },
        kind: "text",
        nullable: true,
        display: { list: false },
        control: { kind: "textarea" },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: z.string().nullable().optional(),
        },
      },
      timestampField("createdAt", { format: "timestamp" }),
      {
        ...timestampField("updatedAt", { list: false, format: "timestamp" }),
        provenance: {
          kind: "derived",
          sources: [{ label: "Current reconciliation update" }],
        },
      },
      {
        output: false,
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
        validation: readOnly(dateTime.nullable()),
      },
      {
        output: false,
        key: "shortcode",
        kind: "text",
        validation: readOnly(z.string()),
      },
      {
        key: "importFingerprint",
        provenance: {
          kind: "derived",
          sources: [{ label: "First import fingerprint" }],
        },
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        key: "accountName",
        provenance: {
          kind: "derived",
          sources: [{ label: "Mapped account name" }],
        },
        kind: "text",
        nullable: true,
        display: { columnGroup: "Reconciliation" },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "supersededBy",
        provenance: {
          kind: "derived",
          sources: [{ label: "Reviewed successor source reference" }],
        },
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      {
        key: "matchState",
        provenance: {
          kind: "derived",
          sources: [
            { label: "Accepted settlement references and charge judgments" },
          ],
        },
        kind: "enum",
        display: {
          mobile: { slot: "meta", priority: 30 },
          columnGroup: "Reconciliation",
          optionRole: "status",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Info", sfSymbol: "info.circle" },
        },
        control: {
          kind: "select",
          options: sourceTransactionRecordMatchState.options.map((value) => ({
            value,
            label: capitalize(value.replaceAll("_", " ")),
            color: "neutral-status",
            glyph: { phosphor: "Info", sfSymbol: "info.circle" },
            ...(value === "matched" ? { quiet: true as const } : {}),
          })),
        },
        validation: readOnly(sourceTransactionRecordMatchState),
      },
      {
        key: "historicalTransactionIds",
        kind: "json",
        label: "Historical transactions (evidence only)",
        provenance: {
          kind: "derived",
          sources: [
            {
              label:
                "Retained historical bindings; these do not establish accepted ownership",
            },
          ],
        },
        display: { list: false, detailLabelPath: "historicalTransactionIds[]" },
        validation: readOnly(z.array(shortcodeSchema("financialTransaction"))),
      },
      {
        key: "transactionId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "financialTransaction" },
        display: { columnGroup: "Reconciliation" },
        validation: readOnly(
          shortcodeSchema("financialTransaction").nullable(),
        ),
      },
      {
        key: "vendorInference",
        provenance: {
          kind: "derived",
          sources: [{ label: "Advisory merchant matching" }],
        },
        kind: "json",
        nullable: true,
        display: {
          columnGroup: "Reconciliation",
          detailLabelPath: "vendorInference.candidates[].vendorName",
        },
        validation: readOnly(merchantVendorInference.nullable()),
      },
    ],
    storage: [
      { key: "id", specialized: "primary-key:SourceTransactionRecordId" },
      { key: "shortcode", specialized: "shortcode" },
      "occurrenceId",
      "factFingerprint",
      "batchId",
      {
        key: "source",
        reference: "externalSource",
        referenceOptions: { column: "slug", onUpdate: "cascade" },
      },
      { key: "rowPosition" },
      { key: "providerTransactionId" },
      { key: "providerAccountId" },
      { key: "providerData" },
      { key: "accountDescriptor" },
      { key: "statementDate" },
      { key: "amount", specialized: "minor-unit-money" },
      { key: "providerAmount", specialized: "minor-unit-money" },
      { key: "merchant" },
      { key: "rawDescription" },
      { key: "sourceCategory" },
      { key: "providerStatus" },
      { key: "providerNotes" },
      { key: "createdAt" },
      { key: "deletedAt" },
    ],

    rows: {
      reconciliation: {
        label: "Current reconciliation",
        repository: {
          account: { reference: "financialAccount", connection: true },
          withdrawal: { reference: "transactionImport", connection: true },
          successor: { reference: "sourceTransactionRecord", connection: true },
        },
      },

      receivedImports: { label: "Received imports", relation: "imports" },
      acceptedTransactions: {
        label: "Accepted transactions",
        repository: {
          transaction: {
            reference: "financialTransaction",
            connection: true,
          },
        },
      },
    },
    derived: {
      externalId: { type: "text" },
      legacyExternalId: { type: "text" },
      chargeKey: { type: "text" },
      current: { type: "boolean" },
      withdrawnAt: { type: "date" },
      lastObservedAt: { type: "date" },
      updatedAt: { type: "date" },
      notes: { type: "text" },
      dispositionNote: { type: "text" },
      disposition: {
        type: "enum",
        options: sourceTransactionRecordDisposition.options,
      },
      dispositionReason: {
        type: "enum",
        options: sourceTransactionRecordDispositionReason.options,
      },
      accountId: { via: "reconciliation.account" },
      withdrawalImportId: { via: "reconciliation.withdrawal" },
      supersededByRowId: { via: "reconciliation.successor" },

      importId: { via: "imports" },
      matchState: {
        type: "enum",
        options: sourceTransactionRecordMatchState.options,
      },
      importFingerprint: { via: "receivedImports.fingerprint" },
      transactionId: { via: "acceptedTransactions.transaction" },
    },
    intents: {
      fields: {
        full: [
          "accountId",
          "disposition",
          "dispositionReason",
          "dispositionNote",
          "notes",
          "supersededByRowId",
        ],
      },
      create: [],
      update: ["full"],
    },
    sort: {
      fields: [
        "statementDate",
        "amount",
        "accountDescriptor",
        "rawDescription",
        "createdAt",
      ],
    },
  },
  fields: {
    create: null,
  },
  storage: {
    uniqueKeys: [
      {
        name: "SourceTransactionRecord_id_occurrence_key",
        columns: ["id", "occurrenceId"],
      },
    ],
    indexes: [
      {
        name: "SourceTransactionRecord_occurrence_facts_idx",
        on: ["occurrenceId", "factFingerprint"],
      },
      {
        name: "SourceTransactionRecord_batch_position_key",
        unique: true,
        on: ["batchId", "rowPosition"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "SourceTransactionRecord_source_providerTransactionId_idx",
        on: ["source", "providerTransactionId"],
      },
      {
        name: "SourceTransactionRecord_statementDate_idx",
        on: ["statementDate"],
      },
      {
        name: "SourceTransactionRecord_descriptor_date_amount_idx",
        on: ["source", "accountDescriptor", "statementDate", "providerAmount"],
      },
      {
        name: "SourceTransactionRecord_amount_date_idx",
        on: ["providerAmount", "statementDate"],
      },
      {
        name: "SourceTransactionRecord_rawDescription_gin_idx",
        using: "gin",
        on: [{ sql: "{rawDescription} gin_trgm_ops" }],
      },
    ],
    checks: [
      {
        name: "SourceTransactionRecord_position_check",
        sql: "{rowPosition} IS NULL OR {rowPosition} > 0",
      },
      {
        name: "SourceTransactionRecord_source_slug_check",
        sql: "{source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND {source} = lower(trim({source}))",
      },
      {
        name: "SourceTransactionRecord_amount_range_check",
        sql: "abs({amount}) <= 100000000000000",
      },
      {
        name: "SourceTransactionRecord_providerAmount_range_check",
        sql: "abs({providerAmount}) <= 100000000000000",
      },
      { column: "providerStatus", nullClause: true },
    ],
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/source-transaction-record",
      export: "sourceTransactionRecordFilterFields",
    },
    descriptors: [
      {
        columnId: "withdrawnAt",
        label: "Withdrawn at",
        kind: "range",
        deriveSchema: true,
        derived: true,
        range: { kind: "date" },
        wire: {
          kind: "range",
          from: "withdrawnAtFrom",
          to: "withdrawnAtTo",
          presence: "withdrawnAtPresenceFilter",
        },
        placeholder: "Filter by withdrawn at...",
        options: [
          { value: "has", label: "Has date", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "lastObservedAt",
        label: "Last observed",
        kind: "range",
        deriveSchema: true,
        derived: true,
        range: { kind: "date" },
        wire: {
          kind: "range",
          from: "lastObservedAtFrom",
          to: "lastObservedAtTo",
        },
        placeholder: "Filter by last observed...",
      },

      {
        columnId: "rawDescription",
        field: "search",
        urlKey: "q",
        kind: "text",
        deriveSchema: true,
        anyOf: ["rawDescription", "merchant", "accountDescriptor"],
        placeholder: "Filter search...",
      },
      {
        columnId: "source",
        kind: "text",
        deriveSchema: true,
        placeholder: "Filter source...",
        anyOf: ["source"],
      },
      {
        columnId: "chargeKey",
        kind: "multiselect",
        deriveSchema: true,
        derived: true,
        placeholder: "Filter source occurrence...",
      },
      {
        columnId: "providerTransactionId",
        kind: "multiselect",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter provider transaction ID...",
      },
      {
        columnId: "providerAccountId",
        kind: "multiselect",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter provider account ID...",
      },
      {
        columnId: "accountId",
        kind: "idMulti",
        brandRef: { entity: "financialAccount" },
        deriveSchema: true,
        placeholder: "Filter accountId...",
      },
      {
        columnId: "batchId",
        kind: "idMulti",
        brandRef: { entity: "transactionImport" },
        deriveSchema: true,
        placeholder: "Filter batchId...",
      },
      {
        columnId: "withdrawalImportId",
        kind: "idMulti",
        brandRef: { entity: "transactionImport" },
        deriveSchema: true,
        placeholder: "Filter withdrawalImportId...",
      },
      {
        columnId: "supersededByRowId",
        kind: "idMulti",
        brandRef: { entity: "sourceTransactionRecord" },
        deriveSchema: true,
        placeholder: "Filter supersededByRowId...",
      },
      {
        columnId: "matchState",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter matchState...",
      },
      {
        columnId: "disposition",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter disposition...",
      },
      {
        columnId: "dispositionReason",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter dispositionReason...",
      },
      {
        columnId: "providerStatus",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter providerStatus...",
      },
      {
        columnId: "statementDate",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter statementDate...",
      },
      {
        columnId: "amount",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter amount...",
      },
      {
        columnId: "sourceCategory",
        kind: "text",
        deriveSchema: true,
        placeholder: "Filter sourceCategory...",
        anyOf: ["sourceCategory"],
      },
      {
        columnId: "importFingerprint",
        kind: "text",
        deriveSchema: true,
        derived: true,
        placeholder: "Filter importFingerprint...",
      },
      {
        columnId: "transactionId",
        kind: "idMulti",
        brandRef: { entity: "financialTransaction" },
        deriveSchema: true,
        placeholder: "Filter transactionId...",
      },
      {
        columnId: "current",
        kind: "boolean",
        deriveSchema: true,
        placeholder: "Filter current...",
      },
      {
        columnId: "importId",
        kind: "idMulti",
        brandRef: { entity: "transactionImport" },
        deriveSchema: true,
        placeholder: "Filter received imports...",
      },
    ],
  },

  search: {
    mode: "lexical",
    inputs: [
      {
        table: "SourceObservationAnnotation",
        match: { observationId: "id" },
        columns: ["notes"],
      },
    ],
  },
  capabilities: {
    images: { storage: false },
    delete: { mode: "soft", bulk: true },
    merge: false,
    timeline: "default",
  },
  extensions: {
    ports: {
      repository: {
        module:
          "~/server/domains/transaction-import/repo/source-transaction-record",
        export: "sourceTransactionRecordRepository",
      },
    },
  },
});

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r.field("occurrenceId").named("occurrence", "Source occurrence"),
        "sourceOccurrence.source-transaction-records",
      ),
      r.declare(
        r.query("sourceObservationAccount", "one").named("account", "Account"),
        "financialAccount.sourceTransactionRecord.account",
      ),
      r.declare(
        r.field("batchId").named("firstImport", "First import"),
        "transactionImport.firstRecords",
      ),
      r.declare(
        r
          .query("sourceObservationWithdrawal", "one")
          .named("withdrawalProof", "Withdrawal proof"),
        "transactionImport.sourceTransactionRecord.withdrawalProof",
      ),
      r.declare(
        r
          .query("sourceObservationSuccessor", "one")
          .named("supersededByRecord", "Superseded by"),
        "sourceTransactionRecord.sourceTransactionRecord.supersededByRecord",
      ),
      r.declare(
        r
          .query("sourceObservationSuccessor", "many", true)
          .named("predecessors", "Superseded records"),
        "sourceTransactionRecord.sourceTransactionRecord.predecessors",
      ),
      r.declare(
        r
          .path("transactionImport", "many", [
            {
              edge: "TransactionImportRecord.statementRowId",
              direction: "incoming",
            },
            { edge: "TransactionImportRecord.importId", direction: "outgoing" },
          ])
          .named("imports", "Imports"),
        "transactionImport.records",
      ),
      r.declare(
        r
          .derived(
            "financialTransaction",
            "many",
            "sourceTransactionRecordId",
            [
              "SourceTransactionRecord.occurrenceId",
              "SourceOccurrence.acceptedTransactionId",
            ],
          )
          .named("transactions", "Transactions", {
            sources: [
              r
                .query("transactionSourceRecords", "many", true)
                .source("accepted", "Accepted settlement"),
            ],
          }),
        "financialTransaction.sourceRecords",
      ),
    ],
  }),
  readSchemas,
);

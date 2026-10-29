import { timestampField } from "./field-policy";
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
  names: {
    singular: "Source transaction record",
    plural: "Source transaction records",
  },
  table: "SourceTransactionRecord",
  identifiers: { brand: "SourceTransactionRecordId", shortcode: "STR-" },
  route: { basePath: "source-transaction-records" },
  presentation: {
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
        key: "id",
        kind: "identifier",
        display: { list: false },
        validation: {
          read: shortcodeSchema("sourceTransactionRecord"),
          create: null,
          update: null,
        },
      },
      {
        key: "displayName",
        provenance: {
          kind: "derived",
          sources: [{ label: "Source description, merchant and account" }],
        },
        kind: "text",
        display: { list: false },
        validation: { read: z.string().min(1), create: null, update: null },
      },
      {
        audit: true,
        key: "batchId",
        kind: "identifier",
        labelOverride: "First import",
        reference: { entity: "transactionImport" },
        display: { columnGroup: "Source" },
        validation: {
          read: shortcodeSchema("transactionImport"),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "source",
        kind: "text",
        display: { columnGroup: "Source" },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        audit: true,
        key: "externalId",
        kind: "text",
        labelOverride: "Source reference",
        display: { columnGroup: "Source" },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        audit: true,
        key: "rowPosition",
        kind: "number",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.number().int().nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "providerTransactionId",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "legacyExternalId",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        output: false,
        audit: true,
        key: "legacyReference",
        kind: "text",
        nullable: true,
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "chargeKey",
        kind: "text",
        display: { list: false },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        audit: true,
        key: "current",
        kind: "boolean",
        display: { columnGroup: "Disposition" },
        validation: { read: z.boolean(), create: null, update: null },
      },
      {
        audit: true,
        key: "withdrawnAt",
        kind: "timestamp",
        nullable: true,
        display: { columnGroup: "Disposition", format: "timestamp" },
        validation: { read: dateTime.nullable(), create: null, update: null },
      },
      {
        audit: true,
        key: "withdrawalImportId",
        kind: "identifier",
        nullable: true,
        labelOverride: "Withdrawal proof",
        reference: { entity: "transactionImport" },
        display: { columnGroup: "Disposition" },
        validation: {
          read: shortcodeSchema("transactionImport").nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "lastObservedAt",
        kind: "timestamp",
        labelOverride: "Last observed",
        display: { list: false, format: "timestamp" },
        validation: { read: dateTime, create: null, update: null },
      },
      {
        audit: true,
        key: "providerAccountId",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "providerData",
        kind: "json",
        nullable: true,
        labelOverride: "Source metadata",
        display: {},
        validation: { read: z.json().nullable(), create: null, update: null },
      },
      {
        audit: true,
        key: "accountDescriptor",
        kind: "text",
        display: { columnGroup: "Source" },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        audit: true,
        key: "statementDate",
        kind: "date",
        labelOverride: "Source date",
        display: { columnGroup: "Source" },
        validation: { read: plainDate, create: null, update: null },
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
        validation: { read: z.number(), create: null, update: null },
      },
      {
        audit: true,
        key: "providerAmount",
        kind: "number",
        labelOverride: "Original signed amount",
        display: { columnGroup: "Source", format: "currency" },
        validation: { read: z.number(), create: null, update: null },
      },
      {
        audit: true,
        key: "merchant",
        kind: "text",
        nullable: true,
        display: { columnGroup: "Source" },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "rawDescription",
        kind: "text",
        display: { columnGroup: "Source" },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        audit: true,
        key: "sourceCategory",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
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
        validation: {
          read: sourceTransactionRecordProviderStatus.nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "providerNotes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "accountId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "financialAccount" },
        display: { columnGroup: "Reconciliation", labelPath: "accountName" },
        validation: {
          read: shortcodeSchema("financialAccount").nullable(),
          create: null,
          update: shortcodeSchema("financialAccount").nullable().optional(),
        },
      },
      {
        key: "disposition",
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
        labelOverride: "Superseded by",
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
      timestampField("updatedAt", { list: false, format: "timestamp" }),
      {
        output: false,
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
        validation: { read: dateTime.nullable(), create: null, update: null },
      },
      {
        output: false,
        key: "shortcode",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "importFingerprint",
        provenance: {
          kind: "derived",
          sources: [{ label: "First import fingerprint" }],
        },
        kind: "text",
        display: { list: false },
        validation: { read: z.string(), create: null, update: null },
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
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
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
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
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
          })),
        },
        validation: {
          read: sourceTransactionRecordMatchState,
          create: null,
          update: null,
        },
      },
      {
        key: "transactionId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "financialTransaction" },
        display: { columnGroup: "Reconciliation" },
        validation: {
          read: shortcodeSchema("financialTransaction").nullable(),
          create: null,
          update: null,
        },
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
        validation: {
          read: merchantVendorInference.nullable(),
          create: null,
          update: null,
        },
      },
    ],
    storage: [
      { key: "id", specialized: "primary-key:SourceTransactionRecordId" },
      { key: "shortcode", specialized: "shortcode" },
      "batchId",
      {
        key: "source",
        reference: "externalSource",
        referenceOptions: { column: "slug", onUpdate: "cascade" },
      },
      { key: "externalId" },
      { key: "rowPosition" },
      { key: "providerTransactionId" },
      { key: "legacyExternalId" },
      { key: "legacyReference" },
      {
        key: "chargeKey",
        defaultOverride: "generated",
        defaultSql: "gen_random_uuid()::text",
      },
      { key: "current", defaultValue: true },
      { key: "withdrawnAt" },
      "withdrawalImportId",
      { key: "lastObservedAt", defaultOverride: "now" },
      { key: "providerAccountId" },
      { key: "providerData" },
      { key: "accountDescriptor" },
      { key: "statementDate" },
      { key: "amount", specialized: "double-precision" },
      { key: "providerAmount", specialized: "double-precision" },
      { key: "merchant" },
      { key: "rawDescription" },
      { key: "sourceCategory" },
      { key: "providerStatus" },
      { key: "providerNotes" },
      "accountId",
      { key: "disposition", defaultValue: "open" },
      { key: "dispositionReason" },
      { key: "dispositionNote" },
      "supersededByRowId",
      { key: "notes" },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      { key: "deletedAt" },
    ],

    rows: {
      runStepInputs: {
        label: "Run step inputs",
        repository: { token: "text" },
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
      runStepInput: { via: "runStepInputs.token" },
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
    indexes: [
      // Invalidation reads include retained tombstones; the live unique key cannot serve them.
      {
        name: "SourceTransactionRecord_source_externalId_lookup_idx",
        on: ["source", "externalId"],
      },
      {
        name: "SourceTransactionRecord_source_externalId_key",
        unique: true,
        on: ["source", "externalId"],
        where: "{deletedAt} IS NULL",
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
        name: "SourceTransactionRecord_source_charge_idx",
        on: ["source", "chargeKey"],
      },
      {
        name: "SourceTransactionRecord_source_legacyReference_idx",
        on: ["source", "legacyReference"],
        where: "{deletedAt} IS NULL AND {legacyReference} IS NOT NULL",
      },
      {
        name: "SourceTransactionRecord_transfer_seed_idx",
        on: [
          {
            sql: "('stmt:' || {source} || ':' || {chargeKey}) COLLATE \"C\"",
          },
        ],
        where: "{deletedAt} IS NULL AND {sourceCategory} IS NOT NULL",
      },
      { name: "SourceTransactionRecord_batchId_idx", on: ["batchId"] },
      {
        name: "SourceTransactionRecord_statementDate_idx",
        on: ["statementDate"],
      },
      {
        name: "SourceTransactionRecord_worklist_idx",
        on: [{ column: "statementDate", desc: true }],
        where:
          "{deletedAt} IS NULL AND {disposition} = 'open' AND {supersededByRowId} IS NULL",
      },
      {
        name: "SourceTransactionRecord_account_date_amount_idx",
        on: ["accountId", "statementDate", "amount"],
      },
      {
        name: "SourceTransactionRecord_descriptor_date_amount_idx",
        on: ["source", "accountDescriptor", "statementDate", "providerAmount"],
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
        name: "SourceTransactionRecord_amount_whole_cent_check",
        sql: "abs({amount} * 100 - round({amount} * 100)) < 0.0000001",
      },
      {
        name: "SourceTransactionRecord_providerAmount_whole_cent_check",
        sql: "abs({providerAmount} * 100 - round({providerAmount} * 100)) < 0.0000001",
      },
      {
        name: "SourceTransactionRecord_providerStatus_check",
        sql: "{providerStatus} IS NULL OR {providerStatus} IN ('posted', 'pending')",
      },
      {
        name: "SourceTransactionRecord_disposition_check",
        sql: "({disposition} = 'open' AND {dispositionReason} IS NULL AND {dispositionNote} IS NULL)\n          OR ({disposition} = 'ignored' AND {dispositionReason} IS NOT NULL AND {dispositionNote} IS NOT NULL)",
      },
      {
        name: "SourceTransactionRecord_dispositionReason_check",
        sql: "{dispositionReason} IS NULL OR {dispositionReason} IN\n          ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other')",
      },
      {
        name: "SourceTransactionRecord_externalId_format_check",
        sql: "{externalId} ~ '^v[123]:[0-9a-f]{64}$'",
      },
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
        columnId: "runStepInput",
        kind: "text",
        label: "Run step input",
        placeholder: "RUN shortcode:step key",
        deriveSchema: true,
        schemaRef: {
          module: "@cubby/schemas/run-step-input",
          export: "runStepInputFilterToken",
        },
        derived: true,
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
        stored: true,
        placeholder: "Filter charge key...",
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

  search: "lexical",
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
  (r) => [
    r.field("accountId").named("account", "Account"),
    r.field("batchId").named("firstImport", "First import"),
    r.field("withdrawalImportId").named("withdrawalProof", "Withdrawal proof"),
    r.field("supersededByRowId").named("supersededByRecord", "Superseded by"),
    r
      .path("sourceTransactionRecord", "many", [
        {
          edge: "SourceTransactionRecord.supersededByRowId",
          direction: "incoming",
        },
      ])
      .named("predecessors", "Superseded records"),
    r
      .path("transactionImport", "many", [
        {
          edge: "TransactionImportRecord.statementRowId",
          direction: "incoming",
        },
        { edge: "TransactionImportRecord.importId", direction: "outgoing" },
      ])
      .named("imports", "Imports"),
    r
      .derived("financialTransaction", "many", "sourceTransactionRecordId", [
        "EntityExternalId.settlement_ref",
        "SourceTransactionRecord.chargeKey",
      ])
      .named("transactions", "Transactions", {
        sources: [
          r
            .query("transactionSourceRecords", "many", true)
            .source("accepted", "Accepted settlement"),
        ],
      }),
  ],
  readSchemas,
);

import { timestampField } from "./field-policy";
import { capitalize } from "@cubby/shared/text-case";
import { z } from "zod";
import { dateTime } from "../codec";
import { defineEntity, defineEntityModel } from "./definition.js";
import { shortcodeSchema } from "../identifier-fields";
import { statementDateKind } from "../source-transaction-record-fields";
export const { definition, readSchemas } = defineEntityModel({
  key: "transactionImport",
  names: { singular: "Transaction import", plural: "Transaction imports" },
  table: "TransactionImport",
  identifiers: { brand: "TransactionImportId", shortcode: "TIM-" },
  route: { basePath: "transaction-imports" },
  presentation: {
    titleField: "label",
    domain: "finance",
    description: "One resumable transaction import and its received records.",
    // Import batches run through the web and MCP intake workflow.
    nativeBrowse: false,
    emptyState: {
      title: "No transaction imports yet",
      description: "Record financial evidence through the intake workflow.",
    },
    icons: { phosphor: "Files", sfSymbol: "tray.full", emoji: "📥" },
    list: {
      savedViews: [],
    },
    detail: {
      summary: [
        {
          kind: "fields",
          id: "source-scope",
          title: "Source & scope",
          fields: ["source", "label", "dateKind"],
        },
        {
          kind: "fields",
          id: "intake-counts",
          title: "Intake counts",
          fields: ["rowCountStored", "rowCountDeclared"],
        },
        {
          kind: "records",
          id: "retained-records",
          title: "Retained records",
          viewKey: "relation:records",
        },
        {
          kind: "records",
          id: "first-seen-records",
          title: "First-seen records",
          viewKey: "relation:firstRecords",
        },
        {
          kind: "records",
          id: "withdrawn-records",
          title: "Withdrawn records",
          viewKey: "relation:withdrawnRecords",
        },
        {
          kind: "report",
          id: "reconciliation",
          title: "Reconciliation coverage",
          slot: "transactionImport.reconciliation-summary",
        },
      ],

      relationFilterOverrides: {
        records: { descriptor: "importId" },
        firstRecords: { descriptor: "batchId" },
        withdrawnRecords: { descriptor: "withdrawalImportId" },
      },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: [
            "id",
            "source",
            "label",
            "fingerprint",
            "dateKind",
            "rowCountDeclared",
            "observedAt",
            "completedAt",
            "notes",
            "createdAt",
            "updatedAt",
            "rowCountStored",
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
        key: "label",
        kind: "text",
        display: {},
        validation: { read: z.string(), create: null, update: null },
      },
      {
        audit: true,
        key: "fingerprint",
        kind: "text",
        display: { list: false },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        audit: true,
        key: "dateKind",
        kind: "enum",
        display: {
          columnGroup: "Source",
          optionRole: "status",
          optionColor: "neutral-status",
          optionGlyph: { phosphor: "Info", sfSymbol: "info.circle" },
        },
        control: {
          kind: "select",
          options: statementDateKind.options.map((value) => ({
            value,
            label: capitalize(value.replaceAll("_", " ")),
            color: "neutral-status",
            glyph: { phosphor: "Info", sfSymbol: "info.circle" },
          })),
        },
        validation: { read: statementDateKind, create: null, update: null },
      },
      {
        audit: true,
        key: "rowCountDeclared",
        kind: "number",
        nullable: true,
        display: { columnGroup: "Rows", columnBar: true },
        validation: {
          read: z.number().int().nullable(),
          create: null,
          update: null,
        },
      },
      {
        audit: true,
        key: "observedAt",
        kind: "timestamp",
        display: { columnGroup: "Source", format: "timestamp" },
        validation: { read: dateTime, create: null, update: null },
      },
      {
        audit: true,
        key: "coverage",
        kind: "json",
        nullable: true,
        display: {},
        validation: { read: z.json().nullable(), create: null, update: null },
      },
      {
        audit: true,
        key: "completedAt",
        kind: "timestamp",
        nullable: true,
        display: { columnGroup: "Execution", format: "timestamp" },
        validation: { read: dateTime.nullable(), create: null, update: null },
      },
      {
        audit: true,
        key: "notes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
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
        key: "rowCountStored",
        provenance: {
          kind: "derived",
          sources: [{ label: "Retained import membership" }],
        },
        kind: "number",
        display: { columnGroup: "Rows", columnBar: true },
        validation: {
          read: z.number().int().nonnegative(),
          create: null,
          update: null,
        },
      },
    ],
    storage: [
      { key: "id", specialized: "primary-key:TransactionImportId" },
      { key: "shortcode", specialized: "shortcode" },
      {
        key: "source",
        reference: "externalSource",
        referenceOptions: { column: "slug", onUpdate: "cascade" },
      },
      { key: "label" },
      { key: "fingerprint" },
      { key: "dateKind", defaultValue: "unknown" },
      { key: "rowCountDeclared" },
      { key: "observedAt", defaultOverride: "now" },
      { key: "coverage" },
      { key: "completedAt" },
      { key: "notes" },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      { key: "deletedAt" },
    ],

    derived: {
      sourceTransactionRecordId: { via: "records" },
      rowCountStored: { rollup: "count", via: "records" },
    },
    sort: { fields: ["observedAt", "createdAt", "label", "source"] },
  },
  fields: {
    create: null,
    update: null,
  },
  storage: {
    indexes: [
      {
        name: "TransactionImport_source_fingerprint_key",
        unique: true,
        on: ["source", "fingerprint"],
        where: "{deletedAt} IS NULL",
      },
      { name: "TransactionImport_source_idx", on: ["source"] },
    ],
    checks: [
      {
        name: "TransactionImport_source_slug_check",
        sql: "{source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND {source} = lower(trim({source}))",
      },
      {
        name: "TransactionImport_dateKind_check",
        sql: "{dateKind} IN ('posted', 'transaction', 'unknown')",
      },
      {
        name: "TransactionImport_rowCountDeclared_check",
        sql: "{rowCountDeclared} IS NULL OR {rowCountDeclared} >= 0",
      },
    ],
  },
  filters: {
    audit: true,

    descriptors: [
      {
        columnId: "label",
        field: "search",
        urlKey: "q",
        kind: "text",
        deriveSchema: true,
        anyOf: ["label", "source", "fingerprint"],
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
        columnId: "observedAt",
        kind: "range",
        deriveSchema: true,
        stored: true,
        placeholder: "Filter observedAt...",
      },
      {
        columnId: "sourceTransactionRecordId",
        kind: "idMulti",
        brandRef: { entity: "sourceTransactionRecord" },
        deriveSchema: true,
        placeholder: "Filter received source records...",
      },
    ],
  },

  search: "lexical",
  capabilities: {
    images: { storage: false },
    delete: null,
    merge: false,
    lifecycle: "readOnly",
    timeline: "default",
  },
  extensions: {
    ports: {
      // Preserve statement source/fingerprint search presentation without a repository wrapper.
      search: {
        read: {
          module:
            "~/server/domains/transaction-import/repo/search-read-transaction-import",
          export: "transactionImportSearch",
        },
        projection: null,
        semanticText: null,
      },
    },
  },
});

export default defineEntity(
  definition,
  (r) => [
    r
      .path("sourceTransactionRecord", "many", [
        { edge: "TransactionImportRecord.importId", direction: "incoming" },
        {
          edge: "TransactionImportRecord.statementRowId",
          direction: "outgoing",
        },
      ])
      .named("records", "Source transaction records"),
    r
      .path("sourceTransactionRecord", "many", [
        { edge: "SourceTransactionRecord.batchId", direction: "incoming" },
      ])
      .named("firstRecords", "First recorded here"),
    r
      .path("sourceTransactionRecord", "many", [
        {
          edge: "SourceTransactionRecord.withdrawalImportId",
          direction: "incoming",
        },
      ])
      .named("withdrawnRecords", "Withdrawal proof for"),
  ],
  readSchemas,
);

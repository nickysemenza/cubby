import { capitalize } from "@cubby/shared/text-case";
import { z } from "zod";
import { defineEntity } from "./definition.js";
import { shortcodeSchema } from "../identifier-fields";
import { statementDateKind } from "../source-transaction-record-fields";
export default defineEntity({
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
        key: "source",
        kind: "text",
        display: { columnGroup: "Source" },
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "label",
        kind: "text",
        display: {},
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "fingerprint",
        kind: "text",
        display: { list: false },
        validation: { read: z.string(), create: null, update: null },
      },
      {
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
        key: "observedAt",
        kind: "timestamp",
        display: { columnGroup: "Source", format: "timestamp" },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "coverage",
        kind: "json",
        nullable: true,
        display: {},
        validation: { read: z.json().nullable(), create: null, update: null },
      },
      {
        key: "completedAt",
        kind: "timestamp",
        nullable: true,
        display: { columnGroup: "Execution", format: "timestamp" },
        validation: { read: z.date().nullable(), create: null, update: null },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { format: "timestamp" },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { list: false, format: "timestamp" },
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
        validation: { read: z.date().nullable(), create: null, update: null },
      },
      {
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
    create: [],
    update: [],
    audit: [
      "source",
      "label",
      "fingerprint",
      "dateKind",
      "rowCountDeclared",
      "observedAt",
      "coverage",
      "completedAt",
      "notes",
    ],
    output: [
      "id",
      "source",
      "label",
      "fingerprint",
      "dateKind",
      "rowCountDeclared",
      "observedAt",
      "coverage",
      "completedAt",
      "notes",
      "createdAt",
      "updatedAt",
      "rowCountStored",
    ],
    derived: {
      sourceTransactionRecordId: { via: "records" },
      rowCountStored: { type: "number" },
    },
    sort: { fields: ["observedAt", "createdAt", "label", "source"] },
  },
  fields: {
    create: null,
    update: null,
    output: {
      module: "@cubby/schemas/transaction-import-raw-read",
      export: "rawTransactionImportOut",
    },
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
    schema: {
      module: "@cubby/schemas/transaction-import",
      export: "transactionImportFilterFields",
    },
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
  relations: [
    {
      key: "records",
      label: "Source transaction records",
      target: "sourceTransactionRecord",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "TransactionImportRecord.importId", direction: "incoming" },
          {
            edge: "TransactionImportRecord.statementRowId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "TransactionImportRecord.statementRowId",
            direction: "incoming",
          },
          { edge: "TransactionImportRecord.importId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "firstRecords",
      label: "First recorded here",
      target: "sourceTransactionRecord",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "SourceTransactionRecord.batchId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "SourceTransactionRecord.batchId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "withdrawnRecords",
      label: "Withdrawal proof for",
      target: "sourceTransactionRecord",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "SourceTransactionRecord.withdrawalImportId",
            direction: "incoming",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "SourceTransactionRecord.withdrawalImportId",
            direction: "outgoing",
          },
        ],
      },
    },
  ],
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
      repository: {
        module:
          "~/server/domains/transaction-import/repo/source-transaction-record",
        export: "transactionImportRepository",
      },
    },
  },
});

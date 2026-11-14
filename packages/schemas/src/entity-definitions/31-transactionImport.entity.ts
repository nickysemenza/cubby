import { defineEdge } from "./edges";
import { readOnly, timestampField } from "./field-policy";
import { capitalize } from "@cubby/shared/text-case";
import { z } from "zod";
import { dateTime } from "../codec";
import { defineEntity, defineEntityModel } from "./definition.js";
import { shortcodeSchema } from "../identifier-fields";
import { statementDateKind } from "../source-transaction-record-fields";
export const { definition, readSchemas } = defineEntityModel({
  key: "transactionImport",
  edges: [
    defineEdge({
      key: "SourceTransactionRecord.batchId",
      from: "sourceTransactionRecord",
      to: "transactionImport",
      cardinality: "one",
      inverse: {
        key: "transactionImport.incoming.SourceTransactionRecord.batchId",
        from: "transactionImport",
        to: "sourceTransactionRecord",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceTransactionRecord.batchId",
        constrained: true,
      },
      ownership: {
        kind: "entity",
        entity: "sourceTransactionRecord",
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
        label: "first-ingest provenance",
        description: "The import that first retained a source observation.",
        liveness: {
          kind: "must-target-live",
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
      key: "SourceOccurrence.physicalImportId",
      from: "sourceOccurrence",
      to: "transactionImport",
      cardinality: "one",
      inverse: {
        key: "transactionImport.incoming.SourceOccurrence.physicalImportId",
        from: "transactionImport",
        to: "sourceOccurrence",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceOccurrence.physicalImportId",
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
        label: "physical source identities",
        description:
          "The original physical collection reserves each positioned occurrence.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Collection retirement never releases its original position identities.",
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
      key: "SourceOccurrence.withdrawalImportId",
      from: "sourceOccurrence",
      to: "transactionImport",
      cardinality: "one",
      inverse: {
        key: "transactionImport.incoming.SourceOccurrence.withdrawalImportId",
        from: "transactionImport",
        to: "sourceOccurrence",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceOccurrence.withdrawalImportId",
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
        label: "withdrawal proofs",
        description:
          "The completed provider collection that confirmed source withdrawal.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "A retained withdrawal remains evidence after collection retirement.",
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
      key: "SourceObservationAnnotation.withdrawalImportId",
      from: "row:SourceObservationAnnotation",
      to: "transactionImport",
      cardinality: "one",
      inverse: {
        key: "transactionImport.incoming.SourceObservationAnnotation.withdrawalImportId",
        from: "transactionImport",
        to: "row:SourceObservationAnnotation",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "SourceObservationAnnotation.withdrawalImportId",
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
        label: "original withdrawal proofs",
        description:
          "Original observation withdrawal history preserves its collection identity.",
        liveness: {
          kind: "allow-target-deleted",
          reason: "Historical provenance survives collection retirement.",
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
      key: "TransactionImportRecord.importId",
      from: "row:TransactionImportRecord",
      to: "transactionImport",
      cardinality: "one",
      inverse: {
        key: "transactionImport.incoming.TransactionImportRecord.importId",
        from: "transactionImport",
        to: "row:TransactionImportRecord",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "TransactionImportRecord.importId",
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
        label: "received record memberships",
        description:
          "The retained membership of one resumable transaction import.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Retained import membership survives retirement of its collection.",
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

  names: { singular: "Transaction import", plural: "Transaction imports" },
  table: "TransactionImport",
  identifiers: { brand: "TransactionImportId", shortcode: "TIM-" },
  route: { basePath: "transaction-imports" },
  presentation: {
    searchFacts: ["observedAt", "rowCountStored"],
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
      rail: [{ field: "rowCountStored" }, { field: "observedAt" }],
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
        validation: readOnly(shortcodeSchema("transactionImport")),
      },
      {
        audit: true,
        key: "source",
        kind: "text",
        display: {
          mobile: { slot: "subtitle", priority: 10 },
          columnGroup: "Source",
        },
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "label",
        kind: "text",
        display: {},
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "fingerprint",
        kind: "text",
        display: { list: false },
        validation: readOnly(z.string()),
      },
      {
        audit: true,
        key: "dateKind",
        kind: "enum",
        display: {
          mobile: { slot: "meta", priority: 30 },
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
        validation: readOnly(statementDateKind),
      },
      {
        audit: true,
        key: "rowCountDeclared",
        kind: "number",
        nullable: true,
        display: { columnGroup: "Rows", columnBar: true },
        validation: readOnly(z.number().int().nullable()),
      },
      {
        audit: true,
        key: "observedAt",
        kind: "timestamp",
        display: { columnGroup: "Source", format: "timestamp" },
        validation: readOnly(dateTime),
      },
      {
        audit: true,
        key: "coverage",
        kind: "json",
        nullable: true,
        display: {},
        validation: readOnly(z.json().nullable()),
      },
      {
        audit: true,
        key: "completedAt",
        kind: "timestamp",
        nullable: true,
        display: { columnGroup: "Execution", format: "timestamp" },
        validation: readOnly(dateTime.nullable()),
      },
      {
        audit: true,
        key: "notes",
        kind: "text",
        nullable: true,
        display: { list: false },
        validation: readOnly(z.string().nullable()),
      },
      timestampField("createdAt", { format: "timestamp" }),
      timestampField("updatedAt", { list: false, format: "timestamp" }),
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
        key: "rowCountStored",
        provenance: {
          kind: "derived",
          sources: [{ label: "Retained import membership" }],
        },
        kind: "number",
        display: { columnGroup: "Rows", columnBar: true },
        validation: readOnly(z.number().int().nonnegative()),
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
        columnId: "dateKind",
        kind: "multiselect",
        deriveSchema: true,
        placeholder: "Filter by date kind...",
      },
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
        columnId: "completedAt",
        label: "Completed",
        kind: "range",
        deriveSchema: true,
        stored: true,
        wire: {
          kind: "range",
          from: "completedAtFrom",
          to: "completedAtTo",
          presence: "completedAtPresenceFilter",
        },
        placeholder: "Filter by completion time...",
        options: [
          { value: "has", label: "Completed", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
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
      reports: {
        module: "~/server/domains/transaction-import/repo/report-bindings",
        export: "reportBindings",
      },
      // Preserve statement source/fingerprint search presentation without a repository wrapper.
      search: {
        read: {
          module:
            "~/server/domains/transaction-import/repo/search-read-transaction-import",
          export: "transactionImportSearch",
        },
        projection: null,
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
          .path("sourceTransactionRecord", "many", [
            { edge: "TransactionImportRecord.importId", direction: "incoming" },
            {
              edge: "TransactionImportRecord.statementRowId",
              direction: "outgoing",
            },
          ])
          .named("records", "Source transaction records"),
        "sourceTransactionRecord.imports",
      ),
      r.declare(
        r
          .path("sourceTransactionRecord", "many", [
            { edge: "SourceTransactionRecord.batchId", direction: "incoming" },
          ])
          .named("firstRecords", "First recorded here"),
        "sourceTransactionRecord.firstImport",
      ),
      r.declare(
        r
          .query("sourceObservationWithdrawal", "many", true)
          .named("withdrawnRecords", "Withdrawal proof for"),
        "sourceTransactionRecord.transactionImport.withdrawnRecords",
      ),
    ],
  }),
  readSchemas,
);

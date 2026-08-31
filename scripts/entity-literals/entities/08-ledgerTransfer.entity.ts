import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "ledgerTransfer",
  names: { singular: "Ledger Transfer", plural: "Transfers" },
  route: { basePath: "ledger-transfers" },
  table: "LedgerTransfer",
  identifiers: { brand: "LedgerTransferId", shortcode: "LTR-", legacy: null },
  presentation: { titleField: "name" },
  fields: {
    create: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferCreateInput",
    },
    update: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferUpdateData",
    },
    output: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/ledger-transfer",
      export: "ledgerTransferFilterFields",
    },
    descriptors: [
      {
        columnId: "fromPartyId",
        kind: "idMulti",
        placeholder: "Filter by from party...",
        brandRef: { entity: "ledgerParty", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "toPartyId",
        kind: "idMulti",
        placeholder: "Filter by to party...",
        brandRef: { entity: "ledgerParty", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "dateFrom",
        kind: "text",
        placeholder: "Transfer date from...",
        urlOnly: true,
      },
      {
        columnId: "dateTo",
        kind: "text",
        placeholder: "Transfer date to...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "from-party",
      label: "From party",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "incoming" }],
      },
    },
    {
      key: "to-party",
      label: "To party",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "incoming" }],
      },
    },
    {
      key: "evidence-transactions",
      label: "Evidence transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "incoming",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "outgoing",
          },
        ],
      },
    },
  ],
  search: { enabled: false },
  capabilities: {
    auditable: true,
    images: false,
    countable: false,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/ledger-transfer.entity-adapter",
        export: "ledgerTransferEntityAdapter",
      },
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: {
          module: "~/server/repo/shortcode-resolver",
          export: "resolveLiveShortcode",
        },
      },
      filters: {
        module: "~/entities/filter-manifest",
        export: "getEntityFilters",
      },
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
});

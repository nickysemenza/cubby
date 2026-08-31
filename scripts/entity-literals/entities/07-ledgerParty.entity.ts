import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "ledgerParty",
  names: { singular: "Ledger Party", plural: "Ledger Parties" },
  route: { basePath: "ledger-parties" },
  table: "LedgerParty",
  identifiers: { brand: "LedgerPartyId", shortcode: "LPY-", legacy: null },
  presentation: { titleField: "name" },
  fields: {
    create: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyCreateInput",
    },
    update: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyUpdateData",
    },
    output: { module: "@cubby/schemas/ledger-party", export: "ledgerPartyOut" },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/ledger-party",
      export: "ledgerPartyFilterFields",
    },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search ledger parties...",
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        options: [
          { value: "member", label: "Member" },
          { value: "guest", label: "Guest" },
          { value: "household", label: "Household" },
        ],
      },
    ],
  },
  relations: [
    {
      key: "expenses",
      label: "Attributed expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ExpenseAttribution.ledgerPartyId", direction: "incoming" },
          { edge: "ExpenseAttribution.expenseId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "ExpenseAttribution.expenseId", direction: "incoming" },
          { edge: "ExpenseAttribution.ledgerPartyId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "financial-accounts",
      label: "Financial accounts",
      target: "financialAccount",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "outgoing-transfers",
      label: "Outgoing transfers",
      target: "ledgerTransfer",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.fromPartyId", direction: "outgoing" }],
      },
    },
    {
      key: "incoming-transfers",
      label: "Incoming transfers",
      target: "ledgerTransfer",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "LedgerTransfer.toPartyId", direction: "outgoing" }],
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
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: ["get", "list", "create", "update", "delete", "merge"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: { plural: "ledger_parties" },
    ports: {
      repository: {
        module: "~/server/repo/ledger-party.entity-adapter",
        export: "ledgerPartyEntityAdapter",
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

import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "ledgerParty",
  names: { singular: "Ledger Party", plural: "Ledger Parties" },
  route: { basePath: "ledger-parties" },
  table: "LedgerParty",
  identifiers: { brand: "LedgerPartyId", shortcode: "LPY-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          kind: "string",
          write: {
            trim: true,
            min: 1,
            minMessage: "Ledger party name is required",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "kind",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/ledger-party-fields",
            export: "ledgerPartyKind",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { list: true, detail: true },
        validation: {
          kind: "string",
          nullable: true,
          read: true,
          create: { defaultValue: null },
          update: true,
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/identifiers",
              export: "ledgerPartyShortcode",
            },
          },
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: { kind: "timestamp" } },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: { read: { kind: "timestamp" } },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:LedgerPartyId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "kind", specialized: "enum:kind" },
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: ["name", "kind", "notes"],
    update: ["name", "kind", "notes"],
    bulk: [],
    audit: ["name", "kind", "notes"],
    output: ["id", "name", "kind", "notes", "createdAt", "updatedAt"],
  },
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
        deriveSchema: true,
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
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

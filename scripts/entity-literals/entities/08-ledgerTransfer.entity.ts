import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "ledgerTransfer",
  names: { singular: "Ledger Transfer", plural: "Transfers" },
  route: { basePath: "ledger-transfers" },
  table: "LedgerTransfer",
  identifiers: { brand: "LedgerTransferId", shortcode: "LTR-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "fromPartyId",
        kind: "identifier",
        label: "From",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/identifiers",
            export: "ledgerPartyShortcode",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "toPartyId",
        kind: "identifier",
        label: "To",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/identifiers",
            export: "ledgerPartyShortcode",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "fromPartyName",
        kind: "text",
        validation: { read: { kind: "string" }, create: null, update: null },
      },
      {
        key: "toPartyName",
        kind: "text",
        validation: { read: { kind: "string" }, create: null, update: null },
      },
      {
        key: "amount",
        kind: "number",
        control: { kind: "number", renderer: "money" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          write: {
            source: {
              module: "@cubby/schemas/ledger-transfer-fields",
              export: "ledgerTransferAmount",
            },
          },
          read: {
            source: {
              module: "@cubby/schemas/money",
              export: "wholeCentAmount",
            },
          },
          create: true,
          update: true,
        },
      },
      {
        key: "date",
        kind: "date",
        control: { kind: "date" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: { module: "@cubby/schemas/base-entity", export: "plainDate" },
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
        key: "sourceClaims",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        validation: {
          kind: "source",
          write: {
            source: {
              module: "@cubby/schemas/ledger-transfer-fields",
              export: "ledgerSourceClaims",
            },
            nullable: true,
          },
          read: {
            source: {
              module: "@cubby/schemas/ledger-transfer-fields",
              export: "ledgerSourceClaimsOut",
            },
          },
          create: { defaultValue: [] },
          update: true,
        },
      },
      {
        key: "evidenceTransactionIds",
        kind: "identifier",
        label: "Evidence",
        reference: { entity: "financialTransaction", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        display: { list: true, columnId: "evidenceCount" },
        validation: {
          write: {
            kind: "source",
            source: {
              module: "@cubby/schemas/ledger-transfer-fields",
              export: "ledgerTransferEvidenceTransactionIds",
            },
            nullable: true,
          },
          read: {
            kind: "array",
            item: {
              kind: "source",
              source: {
                module: "@cubby/schemas/identifiers",
                export: "financialTransactionShortcode",
              },
            },
          },
          create: { defaultValue: [] },
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
              export: "ledgerTransferShortcode",
            },
          },
        },
      },
      {
        key: "classification",
        kind: "json",
        display: { detail: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/ledger-transfer-fields",
              export: "ledgerTransferClassification",
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
        specialized: "primary-key:LedgerTransferId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "fromPartyId", reference: "ledgerParty" },
      { key: "toPartyId", reference: "ledgerParty" },
      { key: "amount", specialized: "double-precision" },
      "date",
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "fromPartyId",
      "toPartyId",
      "amount",
      "date",
      "notes",
      "sourceClaims",
      "evidenceTransactionIds",
    ],
    update: [
      "fromPartyId",
      "toPartyId",
      "amount",
      "date",
      "notes",
      "sourceClaims",
      "evidenceTransactionIds",
    ],
    bulk: [],
    audit: [
      "fromPartyId",
      "toPartyId",
      "amount",
      "date",
      "notes",
      "sourceClaims",
      "evidenceTransactionIds",
    ],
    output: [
      "id",
      "fromPartyId",
      "toPartyId",
      "fromPartyName",
      "toPartyName",
      "amount",
      "date",
      "notes",
      "classification",
      "sourceClaims",
      "evidenceTransactionIds",
      "createdAt",
      "updatedAt",
    ],
  },
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

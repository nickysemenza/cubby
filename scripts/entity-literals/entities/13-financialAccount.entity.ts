import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "financialAccount",
  names: { singular: "Financial Account", plural: "Accounts" },
  route: { basePath: "financial-accounts" },
  table: "FinancialAccount",
  identifiers: { brand: "FinancialAccountId", shortcode: "FAC-", legacy: null },
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
          min: 1,
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "identity",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { list: true, detail: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/financial-account-fields",
            export: "financialAccountIdentity",
          },
          read: true,
          create: true,
          update: true,
        },
      },
      {
        key: "provisional",
        kind: "boolean",
        control: { kind: "checkbox", section: "details" },
        display: { list: true, detail: true },
        validation: {
          kind: "boolean",
          read: true,
          create: { defaultValue: false },
          update: true,
        },
      },
      {
        key: "sourceAliases",
        kind: "json",
        label: "Aliases",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { list: true, detail: true, columnId: "aliases" },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/financial-account-fields",
            export: "financialAccountSourceAliases",
          },
          read: true,
          create: { defaultValue: [] },
          update: true,
        },
      },
      {
        key: "ledgerPartyId",
        kind: "identifier",
        nullable: true,
        label: "Owner",
        reference: { entity: "ledgerParty" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true, columnId: "ledgerPartyName" },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/identifiers",
            export: "ledgerPartyShortcode",
          },
          nullable: true,
          read: true,
          create: { defaultValue: null },
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
              export: "financialAccountShortcode",
            },
          },
        },
      },
      {
        key: "ledgerPartyName",
        kind: "text",
        nullable: true,
        validation: { read: { kind: "string", nullable: true } },
      },
      {
        key: "transactionCount",
        kind: "number",
        label: "Transactions",
        display: { list: true, detail: true },
        validation: {
          read: { kind: "number", integer: true, nonnegative: true },
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
        specialized: "primary-key:FinancialAccountId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "identity", specialized: "json:identity" },
      { key: "provisional", default: "literal", defaultValue: false },
      {
        key: "sourceAliases",
        default: "literal",
        defaultValue: "'[]'::jsonb",
        specialized: "json:sourceAliases",
      },
      { key: "ledgerPartyId", reference: "ledgerParty" },
      "notes",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "ledgerPartyId",
      "notes",
    ],
    update: [
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "ledgerPartyId",
      "notes",
    ],
    bulk: [],
    audit: [
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "notes",
      "ledgerPartyId",
    ],
    output: [
      "id",
      "name",
      "identity",
      "provisional",
      "sourceAliases",
      "ledgerPartyId",
      "notes",
      "ledgerPartyName",
      "transactionCount",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountCreateInput",
    },
    update: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountUpdateData",
    },
    output: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/financial-account",
      export: "financialAccountFilterFields",
    },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search accounts...",
        deriveSchema: true,
      },
      {
        columnId: "identity",
        field: "identityKind",
        kind: "multiselect",
        placeholder: "Filter by account type...",
        options: [
          { value: "credit_card", label: "Credit card" },
          { value: "bank_account", label: "Bank account" },
          { value: "stored_value", label: "Stored value" },
          { value: "cash", label: "Cash" },
          { value: "other", label: "Other" },
        ],
      },
      {
        columnId: "provisional",
        kind: "boolean",
        placeholder: "Filter by status...",
        deriveSchema: true,
        options: [
          { value: "false", label: "Known" },
          { value: "true", label: "Provisional" },
        ],
      },
      {
        columnId: "aliases",
        field: "sourceAliasPresenceFilter",
        kind: "presence",
        placeholder: "Filter aliases...",
        options: [
          { value: "has", label: "Has aliases", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "last4",
        kind: "text",
        placeholder: "Filter by last four digits...",
        urlOnly: true,
      },
      {
        columnId: "source",
        kind: "multiselect",
        placeholder: "Filter by source...",
        urlOnly: true,
      },
      {
        columnId: "externalAccountId",
        kind: "multiselect",
        placeholder: "Filter by external account id...",
        urlOnly: true,
      },
      {
        columnId: "related:financialAccount.transactions",
        field: "financialTransactionSearch",
        urlKey: "related-financialTransaction",
        kind: "text",
        placeholder: "Search related transactions...",
      },
      {
        columnId: "financialTransactionId",
        kind: "idMulti",
        placeholder: "Filter by related transactions id...",
        urlOnly: true,
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related transactions presence...",
        urlOnly: true,
      },
      {
        columnId: "related:financialAccount.purchases",
        field: "purchaseSearch",
        urlKey: "related-purchase",
        kind: "text",
        placeholder: "Search related purchases...",
      },
      {
        columnId: "purchaseId",
        kind: "idMulti",
        placeholder: "Filter by related purchases id...",
        urlOnly: true,
      },
      {
        columnId: "purchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter related purchases presence...",
        urlOnly: true,
      },
      {
        columnId: "related:financialAccount.vendors",
        field: "vendorSearch",
        urlKey: "related-vendor",
        kind: "text",
        placeholder: "Search related vendors...",
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by related vendors id...",
        urlOnly: true,
      },
      {
        columnId: "vendorPresenceFilter",
        kind: "presence",
        placeholder: "Filter related vendors presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "ledger-party",
      label: "Ledger party",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "incoming" },
        ],
      },
    },
    {
      key: "transactions",
      label: "Transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "purchases",
      label: "Purchases",
      target: "purchase",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "outgoing",
          },
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "vendors",
      label: "Vendors",
      target: "vendor",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Purchase.vendorId", direction: "incoming" },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "outgoing",
          },
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: false,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/financial-account.entity-adapter",
        export: "financialAccountEntityAdapter",
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
      search: {
        projection: {
          module: "~/server/repo/search-document",
          export: "refreshSearchDocument",
        },
        semanticText: {
          module: "~/server/repo/search-document",
          export: "getSearchDocumentEmbeddingText",
        },
        dependentRefresh: {
          module: "~/server/services/mutation-side-effects",
          export: "runMutationSideEffects",
        },
      },
    },
  },
});

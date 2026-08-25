import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "financialAccount",
  names: { singular: "Financial Account" },
  route: { basePath: "financial-accounts" },
  table: "FinancialAccount",
  identifiers: { brand: "FinancialAccountId", shortcode: "FAC-", legacy: null },
  presentation: { titleField: "name" },
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
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialAccount.ledgerPartyId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
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
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
        ],
      },
      deletionPolicy: "restrict",
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
      deletionPolicy: "restrict",
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
      deletionPolicy: "restrict",
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
    merge: false,
    mcp: ["get", "list", "create", "update", "delete"],
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
      lifecycle: {
        policy: {
          module: "~/server/repo/financial-account",
          export: "FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY",
        },
        runtime: {
          module: "~/server/repo/financial-account.entity-adapter",
          export: "financialAccountEntityAdapter",
        },
      },
      relationMutation: { attach: null, detach: null },
    },
  },
});

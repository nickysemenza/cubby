import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "financialTransaction",
  names: { singular: "Financial Transaction", plural: "Transactions" },
  route: { basePath: "financial-transactions" },
  table: "FinancialTransaction",
  identifiers: {
    brand: "FinancialTransactionId",
    shortcode: "FTX-",
    legacy: null,
  },
  presentation: { titleField: "name" },
  fields: {
    create: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionCreateInput",
    },
    update: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionUpdateData",
    },
    output: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/financial-transaction",
      export: "financialTransactionFilterFields",
    },
    descriptors: [
      {
        columnId: "allocationIntegrity",
        kind: "select",
        placeholder: "Filter allocation integrity...",
        urlOnly: true,
      },
      {
        columnId: "transaction",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search transactions...",
      },
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        options: [
          { value: "purchase", label: "Purchase" },
          { value: "refund", label: "Refund" },
          { value: "account_transfer", label: "Account transfer" },
          { value: "credit_card_payment", label: "Credit card payment" },
          { value: "fee", label: "Fee" },
          { value: "interest", label: "Interest" },
          { value: "income", label: "Income" },
          { value: "adjustment", label: "Adjustment" },
          { value: "other", label: "Other" },
        ],
      },
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        options: [
          { value: "expected", label: "Expected" },
          { value: "pending", label: "Pending" },
          { value: "posted", label: "Posted" },
          { value: "void", label: "Void" },
        ],
      },
      {
        columnId: "postedDate",
        kind: "range",
        placeholder: "Filter by posted date...",
        options: [
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolvePostedDate",
        },
      },
      {
        columnId: "accountId",
        kind: "idMulti",
        placeholder: "Filter by account...",
        optionsKey: "account",
        brandRef: { entity: "financialAccount", kind: "shortcode" },
      },
      {
        columnId: "purchaseId",
        kind: "multiselect",
        placeholder: "Filter by purchase...",
        urlOnly: true,
      },
      {
        columnId: "purchasePresence",
        field: "purchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter purchase links...",
        options: [
          { value: "has", label: "Has purchase", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "source",
        kind: "multiselect",
        placeholder: "Filter by source...",
        optionsKey: "source",
      },
      {
        columnId: "externalId",
        kind: "multiselect",
        placeholder: "Filter by external id...",
        urlOnly: true,
      },
      {
        columnId: "merchant",
        kind: "text",
        placeholder: "Filter by merchant...",
      },
      {
        columnId: "amount",
        kind: "range",
        placeholder: "Filter by amount...",
        options: [
          { value: "gte1000", label: "$1,000 and up" },
          { value: "gte250", label: "$250 and up" },
          { value: "gte50", label: "$50 and up" },
          { value: "credits", label: "Credits (≤ $0)" },
        ],
        expandRef: {
          module: "~/app/finance/financial-transaction-options",
          export: "resolveAmountFilter",
        },
      },
      {
        columnId: "amountMin",
        kind: "text",
        placeholder: "Minimum amount...",
        urlOnly: true,
      },
      {
        columnId: "amountMax",
        kind: "text",
        placeholder: "Maximum amount...",
        urlOnly: true,
      },
      {
        columnId: "transactionDateFrom",
        kind: "text",
        placeholder: "Transaction date from...",
        urlOnly: true,
      },
      {
        columnId: "transactionDateTo",
        kind: "text",
        placeholder: "Transaction date to...",
        urlOnly: true,
      },
      {
        columnId: "postedDateFrom",
        kind: "text",
        placeholder: "Posted date from...",
        urlOnly: true,
      },
      {
        columnId: "postedDateTo",
        kind: "text",
        placeholder: "Posted date to...",
        urlOnly: true,
      },
      {
        columnId: "related:financialTransaction.vendor",
        field: "vendorSearch",
        urlKey: "related-vendor",
        kind: "text",
        placeholder: "Search related vendor...",
      },
      {
        columnId: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by related vendor id...",
        urlOnly: true,
      },
      {
        columnId: "vendorPresenceFilter",
        kind: "presence",
        placeholder: "Filter related vendor presence...",
        urlOnly: true,
      },
      {
        columnId: "related:financialTransaction.expenses",
        field: "expenseSearch",
        urlKey: "related-expense",
        kind: "text",
        placeholder: "Search related expenses...",
      },
      {
        columnId: "expenseId",
        kind: "idMulti",
        placeholder: "Filter by related expenses id...",
        urlOnly: true,
      },
      {
        columnId: "expensePresenceFilter",
        kind: "presence",
        placeholder: "Filter related expenses presence...",
        urlOnly: true,
      },
      {
        columnId: "related:financialTransaction.products",
        field: "productSearch",
        urlKey: "related-product",
        kind: "text",
        placeholder: "Search related products...",
      },
      {
        columnId: "productId",
        kind: "idMulti",
        placeholder: "Filter by related products id...",
        urlOnly: true,
      },
      {
        columnId: "productPresenceFilter",
        kind: "presence",
        placeholder: "Filter related products presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "account",
      label: "Financial account",
      target: "financialAccount",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "FinancialTransaction.accountId", direction: "incoming" },
        ],
      },
    },
    {
      key: "ledger-transfer",
      label: "Ledger transfer",
      target: "ledgerTransfer",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "FinancialTransaction.ledgerTransferId",
            direction: "incoming",
          },
        ],
      },
    },
    {
      key: "purchase",
      label: "Purchase",
      target: "purchase",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
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
        ],
      },
    },
    {
      key: "vendor",
      label: "Vendor",
      target: "vendor",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
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
        ],
      },
    },
    {
      key: "expenses",
      label: "Expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
          { edge: "Expense.purchaseId", direction: "incoming" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.purchaseId", direction: "outgoing" },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "outgoing",
          },
        ],
      },
    },
    {
      key: "products",
      label: "Products",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "outgoing",
          },
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
        module: "~/server/repo/financial-transaction.entity-adapter",
        export: "financialTransactionEntityAdapter",
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

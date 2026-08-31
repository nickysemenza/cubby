import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "purchase",
  names: { singular: "Purchase", plural: "Purchases" },
  route: { basePath: "purchases" },
  table: "Purchase",
  identifiers: { brand: "PurchaseId", shortcode: "PUR-", legacy: null },
  presentation: { titleField: "displayLabel" },
  fields: {
    create: {
      module: "@cubby/schemas/purchase",
      export: "purchaseCreateInput",
    },
    update: { module: "@cubby/schemas/purchase", export: "purchaseUpdateData" },
    output: { module: "@cubby/schemas/purchase", export: "purchaseOut" },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/purchase",
      export: "purchaseFilterFields",
    },
    descriptors: [
      {
        columnId: "financialReconciliation",
        kind: "select",
        placeholder: "Filter financial reconciliation...",
        urlOnly: true,
      },
      {
        columnId: "purchase",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search order id or label...",
      },
      {
        columnId: "displayLabel",
        field: "displayLabelSearch",
        urlKey: "label",
        kind: "text",
        placeholder: "Search display label...",
      },
      {
        columnId: "vendor",
        field: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        optionsKey: "vendor",
        brandRef: { entity: "vendor", kind: "id" },
      },
      {
        columnId: "orderId",
        field: "orderIdPresenceFilter",
        kind: "presence",
        placeholder: "Filter by order id...",
        options: [
          { value: "has", label: "Has order id", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "date",
        kind: "range",
        placeholder: "Filter by date...",
        options: [
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/app/expenses/expense-options",
          export: "resolveDateRange",
        },
      },
      {
        columnId: "statedTotal",
        field: "statedTotalPresenceFilter",
        kind: "presence",
        placeholder: "Filter by stated total...",
        options: [
          { value: "has", label: "Has stated total", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "expenseCount",
        field: "expenseStatus",
        urlKey: "lines",
        kind: "multiselect",
        placeholder: "Filter by expense status...",
        options: [
          { value: "empty", label: "No expenses" },
          { value: "unpriced", label: "Has unpriced expenses" },
          { value: "priced", label: "Fully priced" },
        ],
      },
      {
        columnId: "expenseTotal",
        urlKey: "lineTotal",
        kind: "range",
        placeholder: "Filter by expense total...",
        options: [
          { value: "gte500", label: "$500 and up" },
          { value: "gte200", label: "$200 and up" },
          { value: "gte100", label: "$100 and up" },
          { value: "nonpositive", label: "Non-positive (≤ $0)" },
        ],
        expandRef: {
          module: "~/app/purchases/purchase-options",
          export: "resolvePurchaseExpenseTotalFilter",
        },
      },
      {
        columnId: "reconciliation",
        kind: "multiselect",
        placeholder: "Filter reconciliation...",
        options: [
          { value: "match", label: "Reconciles" },
          { value: "refund_adjusted", label: "Refund-adjusted" },
          { value: "mismatch", label: "Needs review" },
          { value: "unknown", label: "No stated total" },
        ],
      },
      {
        columnId: "documentCount",
        field: "documentPresenceFilter",
        urlKey: "documents",
        kind: "presence",
        placeholder: "Filter by documents...",
        options: [
          { value: "has", label: "Has documents", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "transactionCount",
        field: "financialTransactionPresenceFilter",
        urlKey: "transactions",
        kind: "presence",
        placeholder: "Filter by transactions...",
        options: [
          { value: "has", label: "Has transactions", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "dataQuality",
        field: "dataStatus",
        kind: "select",
        placeholder: "Filter data quality...",
        options: [
          { value: "complete", label: "Complete", color: "var(--slate)" },
          { value: "needs_data", label: "Needs data", color: "var(--warning)" },
          { value: "defect", label: "Defect", color: "var(--destructive)" },
        ],
      },
      {
        columnId: "dataGaps",
        field: "dataGap",
        kind: "multiselect",
        placeholder: "Filter data gaps...",
        options: [
          { value: "settlement_reference", label: "No settlement evidence" },
          { value: "purchase_date", label: "Missing date" },
          { value: "order_id", label: "Missing order ID" },
          { value: "stated_total", label: "Missing stated total" },
          { value: "empty_expenses", label: "No expense lines" },
          { value: "unpriced_expense", label: "Unpriced expense line" },
          { value: "paperwork_mismatch", label: "Paperwork mismatch" },
        ],
      },
      {
        columnId: "expenseTotalMin",
        urlKey: "lineTotalMin",
        kind: "text",
        placeholder: "Minimum expense total...",
        urlOnly: true,
      },
      {
        columnId: "expenseTotalMax",
        urlKey: "lineTotalMax",
        kind: "text",
        placeholder: "Maximum expense total...",
        urlOnly: true,
      },
      {
        columnId: "related:purchase.expenses",
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
        columnId: "related:purchase.transactions",
        field: "financialTransactionSearch",
        urlKey: "related-financialTransaction",
        kind: "text",
        placeholder: "Search related financial transactions...",
      },
      {
        columnId: "financialTransactionId",
        kind: "idMulti",
        placeholder: "Filter by related financial transactions id...",
        urlOnly: true,
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related financial transactions presence...",
        urlOnly: true,
      },
      {
        columnId: "related:purchase.products",
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
      {
        columnId: "related:purchase.projects",
        field: "projectId",
        urlKey: "related-project",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project", kind: "id" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "projectId",
        kind: "idMulti",
        placeholder: "Filter by project id...",
        brandRef: { entity: "project", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "projectPresenceFilter",
        kind: "presence",
        placeholder: "Filter project presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "vendor",
      label: "Vendor",
      target: "vendor",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Purchase.vendorId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Purchase.vendorId", direction: "incoming" }],
      },
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "PurchaseImage.purchaseId", direction: "incoming" },
          { edge: "PurchaseImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "PurchaseImage.imageId", direction: "incoming" },
          { edge: "PurchaseImage.purchaseId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "financial-transactions",
      label: "Financial transactions",
      target: "financialTransaction",
      cardinality: "many",
      provenance: {
        kind: "local-path",
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
      inverse: {
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
    },
    {
      key: "expenses",
      label: "Expenses",
      target: "expense",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.purchaseId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Expense.purchaseId", direction: "outgoing" }],
      },
    },
    {
      key: "products",
      label: "Products",
      target: "product",
      cardinality: "many",
      sourceKey: "expense",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
        ],
      },
      sources: [
        {
          key: "explicit",
          label: "Explicit product link",
          provenance: {
            kind: "local-path",
            steps: [
              { edge: "PurchaseProduct.purchaseId", direction: "incoming" },
              { edge: "PurchaseProduct.productId", direction: "outgoing" },
            ],
          },
          inverse: {
            steps: [
              { edge: "PurchaseProduct.productId", direction: "incoming" },
              { edge: "PurchaseProduct.purchaseId", direction: "outgoing" },
            ],
          },
        },
      ],
      mutation: {
        source: "explicit",
        itemSchema: {
          module: "@cubby/schemas/common",
          export: "entityRelationReferenceItemSchema",
        },
        adapter: {
          module: "~/server/repo/purchase-products",
          export: "purchaseProductsRelationAdapter",
        },
        audiences: ["browser", "mcp"],
      },
    },
    {
      key: "projects",
      label: "Projects",
      target: "project",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.projectId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Expense.projectId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: true,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: ["get", "list", "search", "create", "update", "delete", "merge"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/purchase.entity-adapter",
        export: "purchaseEntityAdapter",
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

import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "expense",
  names: { singular: "Expense" },
  route: { basePath: "expenses" },
  table: "Expense",
  identifiers: { brand: "ExpenseId", shortcode: "EXP-", legacy: null },
  presentation: { titleField: "name" },
  fields: {
    create: { module: "@cubby/schemas/project", export: "expenseCreateInput" },
    update: { module: "@cubby/schemas/project", export: "expenseUpdateData" },
    output: { module: "@cubby/schemas/project", export: "expenseOut" },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/project", export: "expenseFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search expenses...",
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
        columnId: "dateFrom",
        kind: "text",
        placeholder: "Expense date from...",
        urlOnly: true,
      },
      {
        columnId: "dateTo",
        kind: "text",
        placeholder: "Expense date to...",
        urlOnly: true,
      },
      {
        columnId: "dateRelative",
        kind: "select",
        placeholder: "Filter by relative date...",
        urlOnly: true,
      },
      {
        columnId: "costType",
        kind: "multiselect",
        placeholder: "Filter by cost type...",
        options: [
          { value: "materials", label: "Materials", color: "var(--chart-1)" },
          { value: "tools", label: "Tools", color: "var(--chart-5)" },
          { value: "services", label: "Services", color: "var(--chart-2)" },
        ],
      },
      {
        columnId: "lineKind",
        kind: "multiselect",
        placeholder: "Filter by line kind...",
        options: [
          {
            value: "principal",
            label: "Item or service",
            color: "var(--slate)",
          },
          { value: "tax", label: "Tax", color: "var(--slate)" },
          {
            value: "shipping",
            label: "Shipping or delivery",
            color: "var(--slate)",
          },
          { value: "discount", label: "Discount", color: "var(--positive)" },
          { value: "fee", label: "Fee", color: "var(--warning)" },
          { value: "tip", label: "Tip", color: "var(--plum)" },
          {
            value: "other_adjustment",
            label: "Other adjustment",
            color: "var(--slate)",
          },
        ],
      },
      {
        columnId: "lineBasis",
        kind: "multiselect",
        placeholder: "Filter by itemization...",
        options: [
          { value: "item_line", label: "Line item", color: "var(--slate)" },
          {
            value: "allocation",
            label: "Share of a lump sum",
            color: "var(--plum)",
          },
        ],
      },
      {
        columnId: "trade",
        kind: "multiselect",
        placeholder: "Filter by trade...",
        optionsRef: {
          module: "~/app/projects/trade-options",
          export: "tradeOptions",
        },
      },
      {
        columnId: "future",
        kind: "boolean",
        placeholder: "Filter by status...",
        options: [
          { value: "true", label: "Planned" },
          { value: "false", label: "Already made" },
        ],
      },
      {
        columnId: "cost",
        kind: "range",
        placeholder: "Filter by cost...",
        options: [
          { value: "has", label: "Has cost", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "gte500", label: "$500 and up" },
          { value: "gte200", label: "$200 and up" },
          { value: "gte100", label: "$100 and up" },
          { value: "credits", label: "Credits (≤ $0)" },
        ],
        expandRef: {
          module: "~/app/expenses/expense-options",
          export: "resolveCostFilter",
        },
      },
      {
        columnId: "costMin",
        kind: "text",
        placeholder: "Minimum cost...",
        urlOnly: true,
      },
      {
        columnId: "costMax",
        kind: "text",
        placeholder: "Maximum cost...",
        urlOnly: true,
      },
      {
        columnId: "costSign",
        kind: "select",
        placeholder: "Filter by cost direction...",
        urlOnly: true,
      },
      {
        columnId: "disposalPurchasePresenceFilter",
        kind: "presence",
        placeholder: "Filter disposal purchase presence...",
        urlOnly: true,
      },
      {
        columnId: "productQuantity",
        kind: "range",
        placeholder: "Filter by quantity...",
        options: [
          { value: "has", label: "Has quantity", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "exactly1", label: "Exactly 1" },
          { value: "gte2", label: "2+ units" },
          { value: "gte5", label: "5+ units" },
        ],
        expandRef: {
          module: "~/app/expenses/expense-options",
          export: "resolveProductQuantityFilter",
        },
      },
      {
        columnId: "productQuantityMin",
        kind: "text",
        placeholder: "Minimum product quantity...",
        urlOnly: true,
      },
      {
        columnId: "productQuantityMax",
        kind: "text",
        placeholder: "Maximum product quantity...",
        urlOnly: true,
      },
      {
        columnId: "notesSearch",
        kind: "text",
        placeholder: "Search notes...",
        urlOnly: true,
      },
      {
        columnId: "urlSearch",
        kind: "text",
        placeholder: "Search url...",
        urlOnly: true,
      },
      {
        columnId: "project",
        field: "projectId",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project", kind: "id" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "includeSubProjects",
        urlKey: "subprojects",
        kind: "boolean",
        placeholder: "Include sub-projects...",
        urlOnly: true,
      },
      {
        columnId: "productId",
        kind: "id",
        placeholder: "Filter by product id...",
        brandRef: { entity: "product", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "product",
        field: "productPresenceFilter",
        kind: "presence",
        placeholder: "Filter by product...",
        options: [
          { value: "has", label: "Has product", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "vendor",
        field: "vendorId",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        optionsKey: "vendor",
        brandRef: { entity: "vendor", kind: "id" },
        nullable: { field: "vendorPresenceFilter", label: "purchase" },
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
        columnId: "orderIdExact",
        field: "orderId",
        urlKey: "order",
        kind: "id",
        placeholder: "Filter by order id...",
        urlOnly: true,
      },
      {
        columnId: "purchaseId",
        kind: "id",
        placeholder: "Filter by purchase id...",
        brandRef: { entity: "purchase", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "related:expense.transactions",
        field: "financialTransactionSearch",
        urlKey: "related-financialTransaction",
        kind: "text",
        placeholder: "Search related purchase transactions...",
      },
      {
        columnId: "financialTransactionId",
        kind: "idMulti",
        placeholder: "Filter by related purchase transactions id...",
        urlOnly: true,
      },
      {
        columnId: "financialTransactionPresenceFilter",
        kind: "presence",
        placeholder: "Filter related purchase transactions presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "purchase",
      label: "Purchase",
      target: "purchase",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.purchaseId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Expense.purchaseId", direction: "incoming" }],
      },
    },
    {
      key: "project",
      label: "Project",
      target: "project",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.projectId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Expense.projectId", direction: "incoming" }],
      },
    },
    {
      key: "product",
      label: "Product",
      target: "product",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.productId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Expense.productId", direction: "incoming" }],
      },
    },
    {
      key: "transactions",
      label: "Purchase transactions",
      target: "financialTransaction",
      provenance: {
        kind: "local-path",
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
      deletionPolicy: "restrict",
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
          { edge: "Expense.purchaseId", direction: "incoming" },
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
        module: "~/server/repo/expense/entity-adapter",
        export: "expenseEntityAdapter",
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
          module: "~/server/repo/expense/crud",
          export: "EXPENSE_DELETE_EDGE_POLICY",
        },
        runtime: {
          module: "~/server/repo/expense/entity-adapter",
          export: "expenseEntityAdapter",
        },
      },
      relationMutation: { attach: null, detach: null },
    },
  },
});

import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "product",
  names: { singular: "Product", plural: "Products" },
  route: { basePath: "products" },
  table: "Product",
  identifiers: { brand: "ProductId", shortcode: "PRD-", legacy: "P-" },
  presentation: { titleField: "name" },
  fields: {
    create: { module: "@cubby/schemas/product", export: "productCreateInput" },
    update: { module: "@cubby/schemas/product", export: "productUpdateData" },
    output: { module: "@cubby/schemas/product", export: "productTopLevelOut" },
    list: { module: "@cubby/schemas/product", export: "productListItemOut" },
    detail: { module: "@cubby/schemas/product", export: "productWithFoodOut" },
    mcpOutput: {
      module: "@cubby/schemas/product",
      export: "productTopLevelMcpEntityOut",
    },
    mcpList: {
      module: "@cubby/schemas/product",
      export: "productListItemMcpEntityOut",
    },
    mcpDetail: {
      module: "@cubby/schemas/product",
      export: "productWithFoodMcpEntityOut",
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/product", export: "productFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "nameFilter",
        kind: "text",
        placeholder: "Filter by name...",
      },
      {
        columnId: "manufacturer",
        field: "manufacturerExact",
        kind: "multiselect",
        placeholder: "Filter by manufacturer...",
        optionsKey: "manufacturers",
      },
      {
        columnId: "manufacturerSearch",
        field: "manufacturerFilter",
        kind: "text",
        placeholder: "Search manufacturer...",
        urlOnly: true,
      },
      {
        columnId: "primaryGtin",
        field: "upcFilter",
        kind: "text",
        placeholder: "Filter by UPC...",
      },
      {
        columnId: "model",
        field: "modelFilter",
        kind: "text",
        placeholder: "Filter by model...",
      },
      {
        columnId: "modelPresence",
        field: "modelPresenceFilter",
        kind: "presence",
        placeholder: "Filter model presence...",
        options: [
          { value: "has", label: "Has model", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "upcPresence",
        field: "upcPresenceFilter",
        kind: "presence",
        placeholder: "Filter UPC presence...",
        options: [
          { value: "has", label: "Has UPC", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "category",
        field: "categoryFilter",
        kind: "multiselect",
        placeholder: "Filter by category...",
        optionsRef: {
          module: "~/app/_components/products/product-category-icons",
          export: "productCategoryOptionsWithTheme",
        },
        nullable: { field: "categoryPresenceFilter", label: "category" },
      },
      {
        columnId: "location",
        field: "locationIdFilter",
        kind: "idMulti",
        placeholder: "Filter locations...",
        optionsKey: "productLocations",
        brandRef: { entity: "location", kind: "id" },
        nullable: { field: "inventoryPresenceFilter", label: "inventory" },
      },
      {
        columnId: "servingAsLocations",
        field: "servingAsLocationPresenceFilter",
        kind: "presence",
        placeholder: "Filter in service...",
        options: [
          { value: "has", label: "Has in service as a location", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "ingredient",
        field: "ingredientIdFilter",
        kind: "idMulti",
        placeholder: "Filter ingredient...",
        optionsKey: "productIngredients",
        brandRef: { entity: "ingredient", kind: "id" },
        nullable: { field: "ingredientPresenceFilter", label: "ingredient" },
      },
      {
        columnId: "expenses",
        kind: "range",
        placeholder: "Filter expenses...",
        options: [
          { value: "has", label: "Has expenses", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "1", label: "1+ expenses" },
          { value: "2", label: "2+ expenses" },
          { value: "5", label: "5+ expenses" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveExpenseCount",
        },
      },
      {
        columnId: "expenseTotal",
        kind: "range",
        placeholder: "Filter net basis...",
        options: [
          { value: "positive", label: "Positive basis" },
          { value: "zero", label: "Zero basis" },
          { value: "negative", label: "Credit / negative" },
          { value: "gte100", label: "$100 and up" },
          { value: "gte500", label: "$500 and up" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveNetBasis",
        },
      },
      {
        columnId: "expectedQuantity",
        kind: "range",
        placeholder: "Filter expected quantity...",
        options: [
          { value: "negative", label: "Negative (sold more than bought)" },
          { value: "zero", label: "Zero (none expected)" },
          { value: "positive", label: "One or more expected" },
          { value: "gte5", label: "5 or more expected" },
          { value: "unknown", label: "Has lines with no quantity" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveExpectedQuantity",
        },
      },
      {
        columnId: "quantityVariance",
        kind: "range",
        placeholder: "Filter shelf vs. ledger...",
        options: [
          { value: "mismatched", label: "Shelf disagrees with ledger" },
          { value: "matched", label: "Shelf matches ledger" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveQuantityVariance",
        },
      },
      {
        columnId: "notes",
        field: "notesFilter",
        kind: "text",
        placeholder: "Search notes...",
      },
      {
        columnId: "notesPresence",
        field: "notesPresenceFilter",
        kind: "presence",
        placeholder: "Filter notes presence...",
        options: [
          { value: "has", label: "Has notes", meta: true },
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
          { value: "product_manufacturer", label: "Manufacturer" },
          { value: "product_category", label: "Category" },
          { value: "product_model", label: "Model" },
          { value: "product_image", label: "No image (stocked)" },
          { value: "amazon_asin", label: "Amazon ASIN" },
          { value: "duplicate_external_id", label: "Duplicate external ID" },
        ],
      },
      {
        columnId: "externalIds",
        field: "externalIdSource",
        kind: "multiselect",
        placeholder: "Filter by external ID source...",
        optionsKey: "externalIdSources",
        nullable: { field: "externalIdPresenceFilter", label: "external ID" },
      },
      {
        columnId: "purchaseDate",
        kind: "range",
        placeholder: "Filter by purchase date...",
        options: [
          { value: "has", label: "Has purchase date", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveProductPurchaseDateFilter",
        },
      },
      {
        columnId: "price",
        kind: "range",
        placeholder: "Filter price...",
        options: [
          { value: "has", label: "Has price", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "none-real", label: "No price (excluding buckets)" },
          { value: "none-bucket", label: "No price (buckets only)" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolvePrice",
        },
      },
      {
        columnId: "food",
        field: "usdaPresenceFilter",
        kind: "presence",
        placeholder: "Filter USDA...",
        options: [
          { value: "has", label: "Has USDA key", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "image",
        field: "imagePresenceFilter",
        kind: "presence",
        placeholder: "Filter images...",
        options: [
          { value: "has", label: "Has image", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "inventoryMultiplicity",
        field: "inventoryMultiplicity",
        kind: "select",
        placeholder: "Filter inventory multiplicity...",
        options: [
          {
            value: "duplicate_within_placement",
            label: "Duplicate within placement",
          },
        ],
      },
      {
        columnId: "kitAccounting",
        field: "kitAccounting",
        kind: "select",
        placeholder: "Filter kit accounting...",
        options: [{ value: "double_counted", label: "Counted twice" }],
      },
      {
        columnId: "ownershipReconciliation",
        field: "ownershipReconciliation",
        kind: "select",
        placeholder: "Filter ownership reconciliation...",
        options: [
          {
            value: "disposed_still_on_hand",
            label: "Disposed but still on hand",
          },
        ],
      },
      {
        columnId: "conversionCoverage",
        field: "conversionCoverage",
        kind: "select",
        placeholder: "Filter conversion coverage...",
        options: [{ value: "partial", label: "Partial coverage" }],
      },
      {
        columnId: "conversionTopology",
        field: "conversionTopology",
        kind: "select",
        placeholder: "Filter conversion topology...",
        options: [{ value: "islanded", label: "Islanded mappings" }],
      },
      {
        columnId: "unitMappingQuality",
        field: "unitMappingPresenceFilter",
        kind: "presence",
        placeholder: "Filter mappings...",
        options: [
          { value: "has", label: "Has mappings", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "stockTracked",
        field: "stockTrackedPresenceFilter",
        kind: "presence",
        placeholder: "Filter stock tracking...",
        options: [
          { value: "none", label: "Undecided" },
          { value: "has", label: "Reviewed" },
        ],
      },
      {
        columnId: "components",
        field: "componentPresenceFilter",
        kind: "presence",
        placeholder: "Filter kits...",
        options: [
          { value: "has", label: "Is a kit" },
          { value: "none", label: "Not a kit" },
        ],
      },
      {
        columnId: "tags",
        field: "tagFilters",
        kind: "multiselect",
        placeholder: "Filter by tag...",
        optionsKey: "tags",
        nullable: { field: "tagsPresenceFilter", label: "tags" },
      },
      {
        columnId: "related:product.vendors",
        field: "vendorId",
        urlKey: "related-vendor",
        kind: "idMulti",
        placeholder: "Filter by vendor...",
        optionsKey: "productVendors",
        brandRef: { entity: "vendor", kind: "id" },
        nullable: { field: "vendorPresenceFilter", label: "vendor" },
      },
      {
        columnId: "related:product.projects",
        field: "projectId",
        urlKey: "related-project",
        kind: "idMulti",
        placeholder: "Filter by project...",
        optionsKey: "project",
        brandRef: { entity: "project", kind: "id" },
        nullable: { field: "projectPresenceFilter", label: "project" },
      },
      {
        columnId: "related:product.usedOnProjects",
        field: "usedOnProjectSearch",
        urlKey: "related-usedOnProject",
        kind: "text",
        placeholder: "Search related used on projects...",
      },
      {
        columnId: "usedOnProjectId",
        kind: "idMulti",
        placeholder: "Filter by related used on projects id...",
        urlOnly: true,
      },
      {
        columnId: "usedOnProjectPresenceFilter",
        kind: "presence",
        placeholder: "Filter related used on projects presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.purchases",
        field: "purchaseId",
        urlKey: "related-purchase",
        kind: "idMulti",
        placeholder: "Filter by purchase...",
        optionsKey: "productPurchases",
        brandRef: { entity: "purchase", kind: "id" },
        nullable: { field: "purchasePresenceFilter", label: "purchase" },
      },
      {
        columnId: "related:product.expenses",
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
        columnId: "related:product.inventory",
        field: "relatedInventorySearch",
        urlKey: "related-relatedInventory",
        kind: "text",
        placeholder: "Search related inventory...",
      },
      {
        columnId: "relatedInventoryId",
        kind: "idMulti",
        placeholder: "Filter by related inventory id...",
        urlOnly: true,
      },
      {
        columnId: "relatedInventoryPresenceFilter",
        kind: "presence",
        placeholder: "Filter related inventory presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.wishes",
        field: "wishSearch",
        urlKey: "related-wish",
        kind: "text",
        placeholder: "Search related wishlist candidates...",
      },
      {
        columnId: "wishId",
        kind: "idMulti",
        placeholder: "Filter by related wishlist candidates id...",
        urlOnly: true,
      },
      {
        columnId: "wishPresenceFilter",
        kind: "presence",
        placeholder: "Filter related wishlist candidates presence...",
        urlOnly: true,
      },
      {
        columnId: "related:product.tasks",
        kind: "range",
        placeholder: "Filter tasks...",
        options: [
          { value: "has", label: "Has task", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "open", label: "Has open task" },
          {
            value: "not_started",
            label: "Not started",
            color: "var(--chart-neutral)",
          },
          { value: "later", label: "Later", color: "var(--chart-2)" },
          {
            value: "in_progress",
            label: "In progress",
            color: "var(--chart-1)",
          },
          {
            value: "blocked",
            label: "Blocked",
            color: "var(--chart-negative)",
          },
          { value: "done", label: "Done", color: "var(--chart-positive)" },
          { value: "overdue", label: "Overdue" },
          { value: "week", label: "Due this week" },
          { value: "30d", label: "Due in 30 days" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveProductTaskFilter",
        },
      },
      {
        columnId: "taskId",
        kind: "idMulti",
        placeholder: "Filter by related tasks id...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "ingredient",
      label: "Ingredient",
      target: "ingredient",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.ingredientId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Product.ingredientId", direction: "incoming" }],
      },
    },
    {
      key: "project-uses",
      label: "Used on projects",
      target: "project",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ProjectToolUsage.productId", direction: "incoming" },
          { edge: "ProjectToolUsage.projectId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "ProjectToolUsage.projectId", direction: "incoming" },
          { edge: "ProjectToolUsage.productId", direction: "outgoing" },
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
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
          { edge: "Purchase.vendorId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "Purchase.vendorId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "purchased-projects",
      label: "Projects",
      target: "project",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.projectId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "Expense.projectId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "purchases-via-spend",
      label: "Purchases (via spend)",
      target: "purchase",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "Expense.productId", direction: "incoming" },
          { edge: "Expense.purchaseId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "Expense.purchaseId", direction: "incoming" },
          { edge: "Expense.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "expenses",
      label: "Expenses",
      target: "expense",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Expense.productId", direction: "incoming" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Expense.productId", direction: "outgoing" }],
      },
    },
    {
      key: "inventory",
      label: "Inventory",
      target: "inventory",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "InventoryEntry.productId", direction: "incoming" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "InventoryEntry.productId", direction: "outgoing" }],
      },
    },
    {
      key: "tasks",
      label: "Tasks",
      target: "task",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Task.subjectProductId", direction: "incoming" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Task.subjectProductId", direction: "outgoing" }],
      },
    },
    {
      key: "wishes",
      label: "Wishlist candidates",
      target: "wish",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "WishCandidate.productId", direction: "incoming" },
          { edge: "WishCandidate.wishId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "WishCandidate.wishId", direction: "incoming" },
          { edge: "WishCandidate.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "locations",
      label: "Serving as locations",
      target: "location",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Location.productId", direction: "incoming" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Location.productId", direction: "outgoing" }],
      },
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "ProductImage.productId", direction: "incoming" },
          { edge: "ProductImage.imageId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "ProductImage.imageId", direction: "incoming" },
          { edge: "ProductImage.productId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "usda-food",
      label: "USDA food",
      target: "usda-food",
      provenance: {
        kind: "external",
        system: "usda-api",
        sourceColumns: ["ProductExternalId.externalId", "Product.fdc_id"],
      },
      deletionPolicy: "restrict",
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: true,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["stockTracked"] },
    merge: true,
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: [
      {
        kind: "semantic",
        label: "Similar meaning",
        pair: "product_to_product",
        weight: 1,
        limit: 8,
      },
      {
        kind: "scalarOverlap",
        label: "Shared tag",
        pair: "product_to_product",
        column: "Product.tags",
        popularityCap: 24,
        scoring: "displayOnly",
      },
    ],
    mcpNames: { overrides: { list: "search_products" } },
    ports: {
      repository: {
        module: "~/server/repo/product/entity-adapter",
        export: "productEntityAdapter",
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
          module: "~/server/repo/product/edge-roles",
          export: "PRODUCT_DELETE_EDGE_POLICY",
        },
        runtime: {
          module: "~/server/repo/product/entity-adapter",
          export: "productEntityAdapter",
        },
      },
      relationMutation: {
        attach: {
          module: "~/server/repo/product-components",
          export: "attachProductComponents",
        },
        detach: {
          module: "~/server/repo/product-components",
          export: "detachProductComponents",
        },
      },
    },
  },
});

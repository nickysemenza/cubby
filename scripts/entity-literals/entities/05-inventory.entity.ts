import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "inventory",
  names: { singular: "Inventory Item", plural: "Inventory" },
  route: { basePath: "inventory" },
  table: "InventoryEntry",
  identifiers: { brand: "InventoryId", shortcode: "INV-", legacy: null },
  presentation: { titleField: "name" },
  fields: {
    create: {
      module: "@cubby/schemas/inventory",
      export: "inventoryCreatePayloadData",
    },
    update: {
      module: "@cubby/schemas/inventory",
      export: "inventoryUpdatePayloadData",
    },
    output: { module: "@cubby/schemas/inventory", export: "inventoryEntryOut" },
    list: {
      module: "@cubby/schemas/inventory",
      export: "inventoryListItemOut",
    },
    detail: {
      module: "@cubby/schemas/inventory",
      export: "inventoryWithLocationAndProductOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/inventory",
      export: "inventoryFilterFields",
    },
    descriptors: [
      {
        columnId: "productId",
        field: "productIdFilter",
        kind: "id",
        placeholder: "Filter by product id...",
        brandRef: { entity: "product", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "locationId",
        field: "locationIdFilter",
        kind: "id",
        placeholder: "Filter by location id...",
        brandRef: { entity: "location", kind: "id" },
        urlOnly: true,
      },
      {
        columnId: "product",
        field: "productNameFilter",
        kind: "text",
        placeholder: "Filter by product...",
      },
      {
        columnId: "location",
        field: "locationNameFilter",
        kind: "text",
        placeholder: "Filter by location...",
      },
      {
        columnId: "manufacturer",
        field: "manufacturerFilter",
        kind: "text",
        placeholder: "Filter by manufacturer...",
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
      },
      {
        columnId: "verifiedAt",
        kind: "range",
        placeholder: "Filter verification date...",
        options: [
          { value: "has", label: "Has verification", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "30d", label: "Last 30 days" },
          { value: "90d", label: "Last 90 days" },
          { value: "ytd", label: "Year to date" },
          { value: "1y", label: "Last 12 months" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveVerifiedDate",
        },
      },
      {
        columnId: "placement",
        field: "placementFilter",
        kind: "select",
        placeholder: "Filter placement...",
        options: [
          { value: "stock", label: "Stock" },
          { value: "installed", label: "Installed" },
          { value: "all", label: "Stock and installed" },
        ],
      },
      {
        columnId: "locationRole",
        field: "locationRole",
        kind: "select",
        placeholder: "Filter location role...",
        options: [{ value: "global_unknown", label: "Global Unknown" }],
      },
      {
        columnId: "valuationStatus",
        field: "valuationStatus",
        kind: "select",
        placeholder: "Filter valuation...",
        options: [
          { value: "valued", label: "Valued" },
          { value: "missing", label: "Missing valuation" },
          {
            value: "missing_with_priced_product",
            label: "Missing despite product price",
          },
        ],
      },
      {
        columnId: "related:inventory.ingredient",
        field: "ingredientSearch",
        urlKey: "related-ingredient",
        kind: "text",
        placeholder: "Search related ingredient...",
      },
      {
        columnId: "ingredientId",
        kind: "idMulti",
        placeholder: "Filter by related ingredient id...",
        urlOnly: true,
      },
      {
        columnId: "ingredientPresenceFilter",
        kind: "presence",
        placeholder: "Filter related ingredient presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "product",
      label: "Product",
      target: "product",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "InventoryEntry.productId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "InventoryEntry.productId", direction: "incoming" }],
      },
    },
    {
      key: "location",
      label: "Location",
      target: "location",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "InventoryEntry.locationId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "InventoryEntry.locationId", direction: "incoming" }],
      },
    },
    {
      key: "ingredient",
      label: "Ingredient",
      target: "ingredient",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "InventoryEntry.productId", direction: "outgoing" },
          { edge: "Product.ingredientId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "Product.ingredientId", direction: "incoming" },
          { edge: "InventoryEntry.productId", direction: "incoming" },
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
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: {
      singular: "inventory_entry",
      plural: "inventory_entries",
      overrides: { list: "list_inventory" },
    },
    ports: {
      repository: {
        module: "~/server/repo/inventory/entity-adapter",
        export: "inventoryEntityAdapter",
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
          module: "~/server/repo/inventory/crud",
          export: "INVENTORY_DELETE_EDGE_POLICY",
        },
        runtime: {
          module: "~/server/repo/inventory/entity-adapter",
          export: "inventoryEntityAdapter",
        },
      },
      relationMutation: { attach: null, detach: null },
    },
  },
});

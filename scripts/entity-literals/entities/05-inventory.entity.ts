import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "inventory",
  names: { singular: "Inventory Item", plural: "Inventory" },
  route: { basePath: "inventory" },
  table: "InventoryEntry",
  identifiers: { brand: "InventoryId", shortcode: "INV-", legacy: null },
  presentation: { titleField: "name" },
  model: {
    fields: [
      {
        key: "productId",
        kind: "identifier",
        label: "Product",
        readKey: null,
        reference: { entity: "product" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true, detailOrder: 2 },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/identifiers",
            export: "productShortcode",
          },
          create: true,
          update: true,
        },
      },
      {
        key: "locationId",
        kind: "identifier",
        label: "Location",
        readKey: null,
        reference: { entity: "location" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true, detailOrder: 1 },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/identifiers",
            export: "locationShortcode",
          },
          create: true,
          update: true,
        },
      },
      {
        key: "amount",
        kind: "json",
        control: { kind: "specialized", renderer: "amount" },
        display: { list: true, detail: true, detailOrder: 0 },
        validation: {
          kind: "source",
          write: {
            source: {
              module: "@cubby/schemas/codec",
              export: "positiveAmount",
            },
          },
          read: {
            source: { module: "@cubby/schemas/codec", export: "amount" },
            description: "Quantity on hand",
          },
          create: true,
          update: true,
        },
      },
      {
        key: "placement",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true },
        validation: {
          kind: "source",
          source: {
            module: "@cubby/schemas/inventory-fields",
            export: "inventoryPlacement",
          },
          write: { optional: true, descriptionAfter: true },
          read: {
            description:
              "'stock' = movable stock; 'installed' = a fixed installation, kept as a record but excluded from browsing, counting and audits",
          },
          create: {
            description:
              "Defaults to 'stock'; pass 'installed' for a fixed fixture.",
          },
          update: {
            description:
              "Flip between movable stock and a fixed installation. Installing something does not move it — the row keeps its location, it just stops being counted.",
          },
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
              export: "inventoryShortcode",
            },
          },
        },
      },
      {
        key: "valuation",
        kind: "json",
        nullable: true,
        display: { list: true },
        validation: {
          read: {
            kind: "source",
            source: {
              module: "@cubby/schemas/inventory-fields",
              export: "inventoryValuation",
            },
            description: "Precomputed value: amount × product price",
          },
        },
      },
      {
        key: "verifiedAt",
        kind: "timestamp",
        nullable: true,
        label: "Verified",
        display: { list: true, detail: true, detailOrder: 3 },
        validation: {
          read: {
            kind: "timestamp",
            nullable: true,
            description:
              "When last verified in an audit session (null = never)",
            descriptionAfter: true,
          },
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        validation: { read: { kind: "timestamp" } },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        validation: { read: { kind: "timestamp" } },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:InventoryItemId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "productId", reference: "product" },
      { key: "amount", specialized: "json:amount" },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
      { key: "locationId", reference: "location" },
      { key: "valuation", kind: "number", specialized: "real" },
      "verifiedAt",
      {
        key: "placement",
        default: "literal",
        defaultValue: "'stock'",
        specialized: "enum:InventoryPlacement",
      },
    ],
    create: ["productId", "locationId", "amount", "placement"],
    update: ["amount", "productId", "locationId", "placement"],
    bulk: [],
    audit: ["amount", "productId", "locationId", "placement"],
    output: [
      "id",
      "amount",
      "valuation",
      "verifiedAt",
      "placement",
      "createdAt",
      "updatedAt",
    ],
  },
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
    mcpDetail: {
      module: "@cubby/schemas/inventory",
      export: "inventoryWithLocationAndProductMcpEntityOut",
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
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "InventoryEntry.productId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "InventoryEntry.productId", direction: "incoming" }],
      },
    },
    {
      key: "location",
      label: "Location",
      target: "location",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "InventoryEntry.locationId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "InventoryEntry.locationId", direction: "incoming" }],
      },
    },
    {
      key: "ingredient",
      label: "Ingredient",
      target: "ingredient",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "InventoryEntry.productId", direction: "outgoing" },
          { edge: "Product.ingredientId", direction: "outgoing" },
        ],
      },
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
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
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
    },
  },
});

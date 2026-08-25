import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "location",
  names: { singular: "Location" },
  route: { basePath: "locations" },
  table: "Location",
  identifiers: { brand: "LocationId", shortcode: "LOC-", legacy: "L-" },
  presentation: { titleField: "name" },
  fields: {
    create: {
      module: "@cubby/schemas/location",
      export: "locationCreateInput",
    },
    update: { module: "@cubby/schemas/location", export: "locationUpdateData" },
    output: { module: "@cubby/schemas/location", export: "locationOut" },
    detail: { module: "@cubby/schemas/location", export: "infLocation" },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/location",
      export: "locationFilterFields",
    },
    descriptors: [
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
        columnId: "lastBulkInventory",
        kind: "range",
        placeholder: "Filter recounts...",
        options: [
          { value: "30", label: "Not counted in 30 days" },
          { value: "60", label: "Not counted in 60 days" },
          { value: "90", label: "Not counted in 90 days" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveRecountAge",
        },
      },
      {
        columnId: "children",
        field: "childPresenceFilter",
        kind: "presence",
        placeholder: "Filter children...",
        options: [
          { value: "has", label: "Has children", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "aiDescription",
        field: "aiDescriptionPresenceFilter",
        kind: "presence",
        placeholder: "Filter descriptions...",
        options: [
          { value: "has", label: "Has description", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "name",
        field: "nameFilter",
        kind: "text",
        placeholder: "Filter by location name...",
      },
      {
        columnId: "type",
        field: "itemTypeFilter",
        kind: "multiselect",
        placeholder: "Filter by type...",
        optionsRef: {
          module: "~/app/_components/locations/location-icons",
          export: "locationTypeOptionsWithTheme",
        },
      },
      {
        columnId: "product",
        field: "productId",
        kind: "idMulti",
        placeholder: "Filter product...",
        optionsKey: "locationProducts",
        brandRef: {
          module: "@cubby/schemas/identifiers",
          export: "unsafeProductId",
        },
        nullable: { field: "productPresenceFilter", label: "product" },
      },
      {
        columnId: "parent",
        field: "parentId",
        kind: "idMulti",
        placeholder: "Filter parent...",
        optionsKey: "parentLocation",
        brandRef: {
          module: "@cubby/schemas/identifiers",
          export: "unsafeLocationId",
        },
        nullable: { field: "parentPresenceFilter", label: "parent" },
      },
      {
        columnId: "inventoryEntries",
        kind: "range",
        placeholder: "Filter inventory...",
        options: [
          { value: "has", label: "Has items", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "1", label: "1+ items" },
          { value: "2", label: "2+ items" },
          { value: "5", label: "5+ items" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveLocationItems",
        },
      },
      {
        columnId: "valuation",
        kind: "range",
        placeholder: "Filter valuation...",
        options: [
          { value: "positive", label: "Positive basis" },
          { value: "zero", label: "Zero basis" },
          { value: "negative", label: "Credit / negative" },
          { value: "gte100", label: "$100 and up" },
          { value: "gte500", label: "$500 and up" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveLocationValuation",
        },
      },
      {
        columnId: "related:location.ingredients",
        field: "ingredientSearch",
        urlKey: "related-ingredient",
        kind: "text",
        placeholder: "Search related ingredients...",
      },
      {
        columnId: "ingredientId",
        kind: "idMulti",
        placeholder: "Filter by related ingredients id...",
        urlOnly: true,
      },
      {
        columnId: "ingredientPresenceFilter",
        kind: "presence",
        placeholder: "Filter related ingredients presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "parent",
      label: "Parent location",
      target: "location",
      provenance: { kind: "unconstrained", edge: "Location.parentId" },
      deletionPolicy: "restrict",
    },
    {
      key: "product",
      label: "Product",
      target: "product",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Location.productId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Location.productId", direction: "incoming" }],
      },
    },
    {
      key: "ingredients",
      label: "Ingredients",
      target: "ingredient",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "InventoryEntry.locationId", direction: "incoming" },
          { edge: "InventoryEntry.productId", direction: "outgoing" },
          { edge: "Product.ingredientId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "Product.ingredientId", direction: "incoming" },
          { edge: "InventoryEntry.productId", direction: "incoming" },
          { edge: "InventoryEntry.locationId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "LocationImage.locationId", direction: "incoming" },
          { edge: "LocationImage.imageId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "LocationImage.imageId", direction: "incoming" },
          { edge: "LocationImage.locationId", direction: "outgoing" },
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
    merge: false,
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/location/entity-adapter",
        export: "locationEntityAdapter",
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
          module: "~/server/repo/location/crud",
          export: "LOCATION_DELETE_EDGE_POLICY",
        },
        runtime: {
          module: "~/server/repo/location/entity-adapter",
          export: "locationEntityAdapter",
        },
      },
      relationMutation: { attach: null, detach: null },
    },
  },
});

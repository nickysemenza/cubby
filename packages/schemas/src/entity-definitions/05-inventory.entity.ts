import { defineEntity } from "./definition.js";
import { amount, positiveAmount } from "@cubby/schemas/codec";
import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "../identifier-fields.js";
import {
  inventoryPlacement,
  inventoryValuation,
} from "@cubby/schemas/inventory-fields";
import { z } from "zod";
export default defineEntity({
  key: "inventory",
  names: { singular: "Inventory Item", plural: "Inventory" },
  route: { basePath: "inventory", create: "dialog", list: true, detail: true },
  table: "InventoryEntry",
  identifiers: { brand: "InventoryId", shortcode: "INV-" },
  // Inventory has no name field; `displayName` ("<product> · <location>")
  // is declared here for the titleField compiler check, but the joins it
  // needs (product/location names) aren't loaded on the bare entity output —
  // only `inventoryListItemOut`/`inventoryWithLocationAndProductOut` (see
  // `inventoryDisplayName` in packages/schemas/src/inventory.ts) carry it.
  presentation: {
    titleField: "displayName",
    domain: "pantry",
    description: "Approximate quantities at physical locations.",
    emptyState: {
      title: "Your cubbies are empty",
      description:
        "Start tracking what you have and where it lives. Scan a barcode or add it by hand.",
      actionLabel: "Add to Inventory",
    },
    icons: { lucide: "Package", sfSymbol: "cube.box" },
    detail: {
      sections: [
        {
          kind: "fields",
          id: "inventory-details",
          title: "Inventory item details",
          fields: [
            "productId",
            "locationId",
            "amount",
            "placement",
            "verifiedAt",
          ],
        },
      ],
    },
    list: {
      actions: ["moveTo", "delete"],
      links: [
        { label: "Recount", path: "/inventory/session" },
        { label: "Bulk edit", path: "/inventory/bulk-edit" },
        { label: "Bulk move", path: "/inventory/bulk-move" },
      ],
    },
  },
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
          read: null,
          create: productShortcode,
          update: productShortcode.optional(),
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
          read: null,
          create: locationShortcode,
          update: locationShortcode.optional(),
        },
      },
      {
        key: "amount",
        kind: "json",
        control: { kind: "specialized", renderer: "amount" },
        display: {
          list: true,
          detail: true,
          detailOrder: 0,
          format: "amount",
          mobile: { slot: "trailing", priority: 0 },
        },
        validation: {
          read: amount.describe("Quantity on hand"),
          create: positiveAmount,
          update: positiveAmount.optional(),
        },
      },
      {
        key: "placement",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true, detail: true, detailOrder: 4 },
        validation: {
          read: inventoryPlacement.describe(
            "'stock' = movable stock; 'installed' = a fixed installation, kept as a record but excluded from browsing, counting and audits",
          ),
          create: inventoryPlacement
            .optional()
            .describe(
              "Defaults to 'stock'; pass 'installed' for a fixed fixture.",
            ),
          update: inventoryPlacement
            .optional()
            .describe(
              "Flip between movable stock and a fixed installation. Installing something does not move it — the row keeps its location, it just stops being counted.",
            ),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: inventoryShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "valuation",
        kind: "json",
        nullable: true,
        display: { list: true },
        validation: {
          read: inventoryValuation.describe(
            "Precomputed value: amount × product price",
          ),
          create: null,
          update: null,
        },
      },
      {
        // Storage-less and deliberately absent from `output`: the bare
        // entity read has no product/location join to compute it from. See
        // `inventoryDisplayName` in `@cubby/schemas/inventory`, used directly
        // by the list/detail output schemas instead.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "verifiedAt",
        kind: "timestamp",
        nullable: true,
        label: "Verified",
        display: { list: true, detail: true, detailOrder: 3 },
        validation: {
          read: z
            .date()
            .nullable()
            .describe("When last verified in an audit session (null = never)"),
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
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
    sort: {
      fields: [
        "createdAt",
        "updatedAt",
        "name",
        "product",
        "location",
        "amount",
        "valuation",
        "verifiedAt",
      ],
      default: "createdAt",
      computed: ["name", "product", "location"],
    },
    intents: {
      fields: {
        capture: ["productId", "locationId", "amount", "placement"],
        full: ["amount", "productId", "locationId", "placement"],
        amount: ["amount"],
        product: ["productId"],
        location: ["locationId"],
        placement: ["placement"],
      },
      create: ["capture", "full"],
      update: ["full", "amount", "product", "location", "placement"],
    },
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
        brandRef: { entity: "product" },
        urlOnly: true,
      },
      {
        columnId: "locationId",
        field: "locationIdFilter",
        kind: "id",
        placeholder: "Filter by location id...",
        brandRef: { entity: "location" },
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
        wire: {
          kind: "range",
          from: "verifiedFrom",
          to: "verifiedTo",
          presence: "verifiedPresenceFilter",
        },
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
    images: {
      storage: false,
      displaySources: [
        {
          relationPath: ["product"],
          priority: 0,
          ordering: "declared",
          identityEvidence: false,
        },
        {
          relationPath: ["location"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        {
          kind: "existingRelated",
          routeId: "inventory-product",
          relationPath: ["product"],
        },
        {
          kind: "existingRelated",
          routeId: "inventory-location",
          relationPath: ["location"],
        },
      ],
      routing: {
        candidateFields: ["notes"],
        temporalFields: ["verifiedAt"],
        lifecycleFilters: [],
        signals: { ocrFields: ["notes"], classifierLabels: ["inventory"] },
        abstention: { minimumScore: 0.8, minimumMargin: 0.16 },
      },
    },
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

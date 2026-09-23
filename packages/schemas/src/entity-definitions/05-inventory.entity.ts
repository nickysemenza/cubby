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
import {
  effectiveInventoryOwnership,
  inventoryOwnershipMode,
} from "@cubby/schemas/inventory-ownership";
import { ledgerPartyShortcode } from "../identifier-fields.js";
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
    icons: { lucide: "Package", sfSymbol: "cube.box", emoji: "🗃️" },
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
            "ownershipMode",
            "ownerLedgerPartyId",
            "effectiveOwnership",
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
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["productId"] },
        },
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
        control: {
          kind: "select",
          options: [
            { value: "stock", label: "Stock" },
            { value: "installed", label: "Installed" },
          ],
        },
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
        key: "ownershipMode",
        kind: "enum",
        label: "Ownership",
        control: {
          kind: "select",
          options: [
            { value: "inherit", label: "Use inherited owner" },
            { value: "person", label: "Person" },
            { value: "unassigned", label: "No individual owner" },
          ],
        },
        display: {
          list: true,
          detail: true,
          detailOrder: 5,
          renderer: { detail: "ownershipMode" },
        },
        validation: {
          read: inventoryOwnershipMode,
          create: inventoryOwnershipMode.default("inherit"),
          update: inventoryOwnershipMode.optional(),
        },
      },
      {
        key: "ownerLedgerPartyId",
        kind: "identifier",
        nullable: true,
        label: "Explicit owner",
        reference: {
          entity: "ledgerParty",
          filters: [{ field: "kind", values: ["member", "guest"] }],
        },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          detail: true,
          detailOrder: 6,
          renderer: { detail: "ownerLedgerPartyId" },
        },
        validation: {
          read: ledgerPartyShortcode.nullable(),
          create: ledgerPartyShortcode.nullable().default(null),
          update: ledgerPartyShortcode.nullable().optional(),
        },
      },
      {
        key: "effectiveOwnership",
        kind: "json",
        label: "Effective owner",
        explanation: {
          ruleId: "inventory.effective-owner",
          version: 1,
          description:
            "Explicit ownership wins; otherwise one recorded acquisition may supply an unambiguous beneficiary or enabled account default.",
          readPath: "effectiveOwnership",
          resolver: "inventoryOwnership",
          actions: ["confirmOwner", "inheritOwner", "editSource"],
        },
        display: {
          detail: true,
          detailOrder: 7,
          renderer: { detail: "effectiveOwnership" },
        },
        provenance: {
          kind: "derived",
          sources: [
            { label: "Stored ownership choice" },
            { label: "Recorded acquisition and beneficiary evidence" },
            { label: "Enabled vendor or payment account default" },
          ],
        },
        validation: {
          read: effectiveInventoryOwnership,
          create: null,
          update: null,
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
        provenance: {
          kind: "derived",
          sources: [
            { label: "Stored inventory valuation" },
            { label: "Current product price and unit mappings" },
          ],
        },
        explanation: {
          ruleId: "inventory.valuation",
          description:
            "This is the stored valuation produced when Cubby last evaluated the inventory amount against the product's pricing and unit mappings. Current inputs are shown as reference evidence and do not recompute the stored value.",
          resolver: "productValuation",
          readPath: "valuation",
          sourceDependencies: [
            { path: "amount", label: "Inventory amount" },
            { path: "product.unitMappings", label: "Current unit mappings" },
            { path: "product.price", label: "Current effective product price" },
          ],
        },
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
      {
        key: "ownershipMode",
        default: "literal",
        defaultValue: "inherit",
        specialized: "enum:ownershipMode",
      },
      { key: "ownerLedgerPartyId", reference: "ledgerParty" },
    ],
    create: [
      "productId",
      "locationId",
      "amount",
      "placement",
      "ownershipMode",
      "ownerLedgerPartyId",
    ],
    update: [
      "amount",
      "productId",
      "locationId",
      "placement",
      "ownershipMode",
      "ownerLedgerPartyId",
    ],
    bulk: [],
    audit: [
      "amount",
      "productId",
      "locationId",
      "placement",
      "ownershipMode",
      "ownerLedgerPartyId",
    ],
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
        capture: [
          "productId",
          "locationId",
          "amount",
          "placement",
          "ownershipMode",
          "ownerLedgerPartyId",
        ],
        full: [
          "amount",
          "productId",
          "locationId",
          "placement",
          "ownershipMode",
          "ownerLedgerPartyId",
        ],
        amount: ["amount"],
        product: ["productId"],
        location: ["locationId"],
        placement: ["placement"],
        ownership: ["ownershipMode", "ownerLedgerPartyId"],
      },
      create: ["capture", "full"],
      update: [
        "full",
        "amount",
        "product",
        "location",
        "placement",
        "ownership",
      ],
    },
    output: [
      "id",
      "amount",
      "valuation",
      "verifiedAt",
      "placement",
      "ownershipMode",
      "ownerLedgerPartyId",
      "effectiveOwnership",
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
        kind: "idMulti",
        placeholder: "Filter classification...",
        brandRef: { entity: "productCategory" },
        optionsKey: "productCategories",
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
        brandRef: { entity: "ingredient" },
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
      key: "owner",
      label: "Owner",
      target: "ledgerParty",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [
          {
            edge: "InventoryEntry.ownerLedgerPartyId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "InventoryEntry.ownerLedgerPartyId",
            direction: "incoming",
          },
        ],
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
          choice: "prompt",
        },
        {
          kind: "existingRelated",
          routeId: "inventory-location",
          relationPath: ["location"],
          choice: "prompt",
        },
        {
          kind: "createSelf",
          routeId: "inventory-new",
          enabled: false,
          disabledReason:
            "Inventory has no image storage of its own; attach photos via the product or location instead",
        },
      ],
      routing: {
        category: "home",
        candidateFields: ["notes"],
        temporalFields: ["verifiedAt"],
        lifecycleFilters: [],
        signals: { ocrFields: ["notes"], classifierLabels: ["crate"] },
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
    dataQuality: {
      checks: [
        {
          id: "inventory_verified",
          facet: "provenance",
          weight: 1,
          label: "Verified",
          message: "This stock entry has never been verified.",
        },
      ],
    },
  },
  extensions: {
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
      search: "document",
    },
  },
});

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
  inventoryOwnershipModeValues,
} from "@cubby/schemas/inventory-ownership";
import { ledgerPartyShortcode } from "../identifier-fields.js";
import { optionalFieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { imageOut } from "./field-primitives.js";
import {
  CURRENT_MEMBER_FILTER,
  OWNER_FILTER_HOUSEHOLD,
  OWNER_FILTER_UNKNOWN,
} from "@cubby/shared";
import { z } from "zod";
export default defineEntity({
  key: "inventory",
  names: { singular: "Inventory Item", plural: "Inventory" },
  route: {
    listColumns: {
      module: "~/features/inventory/list-columns",
      export: "inventoryListOverride",
    },
    basePath: "inventory",
  },
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
    icons: { phosphor: "Package", sfSymbol: "cube.box", emoji: "🗃️" },
    detail: {},
    list: {
      savedViews: [
        // `@me` is the viewing member (ADR 0018); the owner filter matches the
        // effective owner, so inherited stock counts as someone's stuff.
        {
          id: "wardrobe",
          label: "Wardrobe",
          description: "Your clothes and accessories, grouped by category",
          filters: [
            { id: "ownerLedgerPartyId", value: [CURRENT_MEMBER_FILTER] },
            { id: "categoryFeature", value: ["apparel"] },
          ],
          sort: [
            { id: "category", desc: false },
            { id: "product", desc: false },
          ],
          view: "shelf",
          pin: { surface: "home", order: 0 },
        },
        {
          id: "my-stuff",
          label: "My stuff",
          description: "Everything you own, wherever it lives",
          filters: [
            { id: "ownerLedgerPartyId", value: [CURRENT_MEMBER_FILTER] },
          ],
          sort: [
            { id: "category", desc: false },
            { id: "product", desc: false },
          ],
          view: "shelf",
          pin: { surface: "home", order: 1 },
        },
        {
          id: "unconfirmed-owner",
          label: "Confirm my stuff",
          description:
            "Stock inherited as yours from purchases; confirm or reassign it",
          filters: [
            { id: "ownerLedgerPartyId", value: [CURRENT_MEMBER_FILTER] },
            { id: "ownershipMode", value: ["inherit"] },
          ],
          view: "shelf",
        },
        {
          id: "needs-a-home",
          label: "Needs a home",
          description: "Stock waiting in Unknown for a real location",
          filters: [{ id: "locationRole", value: "global_unknown" }],
          sort: [{ id: "createdAt", desc: true }],
          view: "shelf",
          pin: { surface: "home", order: 3 },
        },
        {
          id: "owner-unknown",
          label: "Owner unknown",
          description:
            "Stock whose purchase evidence names no single owner; pick one",
          filters: [
            { id: "ownerLedgerPartyId", value: [OWNER_FILTER_UNKNOWN] },
          ],
        },
        {
          id: "never-verified",
          label: "Never verified",
          description:
            "Entries whose count has never been checked against a shelf",
          // `inventory_verified`'s own `expected` is `placement = 'stock'`
          // (checks/inventory.ts) — the same guard the inventory list's default
          // `placementFilter` applied. Installed fixtures never get a
          // `verifiedAt` (nobody recounts a wired-in dimmer), so including them
          // would make this list permanently undrainable.
          filters: [{ id: "dataGaps", value: ["inventory_verified"] }],
          // Oldest first — the longest-unverified entries lead.
          sort: [{ id: "createdAt", desc: false }],
          problem: {
            key: "neverVerifiedInventory",
            title: "Inventory never confirmed by a recount",
            description:
              "Entries whose count has never been checked against the shelf (oldest first). Recount the location they live in to clear them. `verifiedAt` only started being stamped when audit sessions landed, so most of the inventory starts here — this is a backlog to work down, not a list of mistakes.",
            emptyMessage:
              "Every inventory entry has been verified at least once.",
          },
        },
      ],
      read: {
        relations: ["product", "location", "ownerLedgerPartyId"],
        derived: ["valuation", "effectiveOwnership", "fieldResolutions"],
        media: ["displayImages"],
        quality: ["dataQuality"],
      },
      totals: [
        {
          id: "valuation",
          label: "Valuation",
          keys: ["valuation"],
          format: "currency",
        },
      ],
      extraActions: ["moveTo"],
      links: [{ label: "Suggestions", path: "/meals/suggestions" }],
    },
  },
  model: {
    fields: [
      {
        key: "productId",
        kind: "identifier",
        reference: { entity: "product" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: null,
          create: productShortcode,
          update: productShortcode.optional(),
        },
      },
      {
        key: "locationId",
        kind: "identifier",
        reference: { entity: "location" },
        control: {
          kind: "specialized",
          renderer: "entity-select",
          suggest: { basis: ["productId"] },
        },
        display: { detail: true },
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
        display: { list: true, detail: true },
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
        validation: {
          read: null,
          create: inventoryOwnershipMode.optional(),
          update: inventoryOwnershipMode.optional(),
        },
      },
      {
        key: "ownerLedgerPartyId",
        kind: "identifier",
        nullable: true,
        labelOverride: "Owner",
        reference: {
          entity: "ledgerParty",
          filters: [{ field: "kind", values: ["member", "guest"] }],
        },
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnLabel: "Owner",
          list: true,
          detail: true,
          width: "md",
          labelPath: "effectiveOwnership.effectiveOwner.name",
          renderer: { detail: "ownerLedgerPartyId" },
        },
        resolution: {
          reset: { ownershipMode: "inherit", ownerLedgerPartyId: null },
          none: { ownershipMode: "explicit", ownerLedgerPartyId: null },
          confirm: { ownershipMode: "explicit" },
          // Confirming the inherited owner is the point, not a redundancy.
          redundancy: "intentional",
          labels: { none: "Household", unresolved: "Unknown" },
        },
        explanation: {
          ruleId: "inventory.effective-owner",
          version: 2,
          description:
            "An owner set on the entry (or Household) wins; otherwise one recorded acquisition supplies its beneficiary, then an enabled vendor account default, then an enabled payment account default.",
          projections: {
            list: "fieldResolutions.ownerLedgerPartyId.value",
            detail: "fieldResolutions.ownerLedgerPartyId.value",
            summary: "fieldResolutions.ownerLedgerPartyId.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.ownerLedgerPartyId.sourceEntity",
              label: "Source",
            },
            {
              path: "fieldResolutions.ownerLedgerPartyId.storedValue",
              label: "Stored override",
            },
            {
              path: "fieldResolutions.ownerLedgerPartyId.fallbackValue",
              label: "Inherited value",
            },
          ],
        },
        validation: {
          read: ledgerPartyShortcode.nullable(),
          create: ledgerPartyShortcode.nullable().default(null),
          update: ledgerPartyShortcode.nullable().optional(),
        },
      },
      {
        key: "fieldResolutions",
        kind: "json",
        validation: {
          read: optionalFieldResolutionsSchema,
          create: null,
          update: null,
        },
      },
      {
        // Full ownership trace for the expense-beneficiary confirmation flow;
        // the Owner field above is what every client displays.
        key: "effectiveOwnership",
        kind: "json",
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
        // The list row carries the valuation as a plain amount of money.
        display: {
          list: true,
          width: "md",
          readPath: "valuation",
          format: "currency",
          mobile: { slot: "trailing", priority: 30 },
        },
        provenance: {
          kind: "derived",
          sources: [
            { label: "Inventory amount" },
            { label: "Current product price and unit mappings" },
          ],
        },
        explanation: {
          ruleId: "inventory.valuation",
          description:
            "Computed on every read: the inventory amount routed to money through the product's current price and unit mappings, so a price or mapping change is reflected immediately.",
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
            "Computed on read: amount routed through the product's unit mappings to its current price",
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
        display: {
          list: true,
          detail: true,
          format: "timestamp",
          mobile: { slot: "meta", priority: 60 },
        },
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
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "product", relation: "product" }],
        },
        validation: { read: z.array(imageOut), create: null, update: null },
      },
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:InventoryItemId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "productId", reference: "product" },
      // Stored as `amountValue` + `amountUnit`; the wire shape stays `{ value, unit }`.
      { key: "amount", specialized: "amount-columns" },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
      { key: "locationId", reference: "location" },
      "verifiedAt",
      {
        key: "placement",
        defaultValue: "'stock'",
        specialized: "enum:InventoryPlacement",
      },
      {
        key: "ownershipMode",
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
    derived: {
      name: { via: "product" },
      product: { via: "product" },
      location: { via: "location" },
      category: { via: "product.category" },
      valuation: { type: "number" },
      // The unit, then the size within it.
      amount: { type: "number" },
      valuationStatus: {
        predicate: "select",
        reason:
          "Missing includes priceable entries, so the statuses overlap and are not one row value",
      },
    },
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
        "category",
      ],
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
      "ownerLedgerPartyId",
      "fieldResolutions",
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
  storage: {
    indexes: [
      // Placement is part of the key so a spare on the shelf and one wired
      // into the wall can coexist in the same room — the normal state, not a
      // duplicate.
      {
        name: "InventoryEntry_productId_locationId_key",
        on: [
          "productId",
          "locationId",
          "placement",
          "ownershipMode",
          {
            sql: "coalesce({ownerLedgerPartyId}, '00000000-0000-0000-0000-000000000000'::uuid)",
          },
        ],
        unique: true,
        where: "{deletedAt} IS NULL",
      },
      { name: "InventoryEntry_owner_idx", on: ["ownerLedgerPartyId"] },
      { on: ["createdAt"] },
    ],
    checks: [
      { column: "placement" },
      { column: "ownershipMode", values: [...inventoryOwnershipModeValues] },
      {
        name: "InventoryEntry_ownership_valid",
        sql: "{ownershipMode} = 'explicit' OR {ownerLedgerPartyId} IS NULL",
      },
    ],
    relations: {
      owner: "ownerLedgerPartyId",
      product: "productId",
      location: "locationId",
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
        columnId: "locationSubtree",
        field: "locationSubtreeFilter",
        kind: "idMulti",
        placeholder: "Filter by location, including contents...",
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
        derived: true,
        placeholder: "Filter classification...",
        brandRef: { entity: "productCategory" },
        optionsKey: "productCategories",
      },
      {
        columnId: "categoryFeature",
        field: "categoryFeatureFilter",
        kind: "multiselect",
        label: "Category family",
        placeholder: "Filter category family...",
        optionsKey: "productCategoryFamilies",
      },
      // Matches the EFFECTIVE owner (explicit, else inherited from acquisition
      // evidence), not the stored column: inherited stock is someone's stuff.
      {
        columnId: "ownerLedgerPartyId",
        urlKey: "owner",
        kind: "idMulti",
        label: "Owner",
        placeholder: "Filter by owner...",
        brandRef: { entity: "ledgerParty" },
        deriveSchema: true,
        sentinels: [
          { value: OWNER_FILTER_HOUSEHOLD, label: "Household" },
          { value: OWNER_FILTER_UNKNOWN, label: "Unknown" },
        ],
        schemaDescription:
          "Effective owner: Ledger Party codes, @me, @household (no individual owner) or @unknown (inherits from evidence that names nobody). Values OR together.",
      },
      {
        columnId: "ownershipMode",
        kind: "multiselect",
        label: "Ownership",
        placeholder: "Filter ownership...",
        deriveSchema: true,
        stored: true,
        options: [
          { value: "inherit", label: "Inherited" },
          { value: "explicit", label: "Set here" },
        ],
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
          module: "~/entity/filter-behavior",
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
        derived: true,
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
  search: "semantic",
  capabilities: {
    images: {
      storage: false,
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
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    dataQuality: {
      checks: [
        {
          id: "inventory_unknown_location",
          satisfiedLabel: "Location recorded",
          placement: { field: "locationId" },
          facet: "integrity",
          kind: "defect",
          weight: 2,
          scoreCap: 69,
          exceptions: "forbidden",
          label: "Unknown location",
          message: "This entry is still parked in the global Unknown location.",
        },
        {
          id: "inventory_verified",
          satisfiedLabel: "Inventory verified",
          placement: { field: "verifiedAt" },
          facet: "provenance",
          weight: 1,
          label: "Verified",
          message: "This stock entry has never been verified.",
          coverage: "neverVerifiedInventory",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/inventory/repo/repository",
        export: "inventoryRepository",
      },
      search: "document",
    },
  },
});

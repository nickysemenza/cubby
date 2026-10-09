import { labelField } from "./label-field.js";
import { defineEntity } from "./definition.js";
import { LOCATION_UNSPECIFIED_GROUP_KEY } from "../group-keys";
import { selectControlOptions } from "./select-control-options.js";
import {
  imageShortcode,
  locationShortcode,
  productShortcode,
} from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import {
  locationIdentityProductOut,
  locationType,
  locationValuation,
} from "@cubby/schemas/location-fields";
import { z } from "zod";
export default defineEntity({
  key: "location",
  names: { singular: "Location", plural: "Locations" },
  route: {
    listColumns: {
      module: "~/entity/list-columns/location",
      export: "locationListOverride",
    },
    basePath: "locations",
  },
  table: "Location",
  identifiers: { brand: "LocationId", shortcode: "LOC-" },
  presentation: {
    titleField: "name",
    domain: "pantry",
    description: "The hierarchy of household storage places.",
    emptyState: {
      title: "Nowhere to put things yet",
      description:
        "Create spaces to organize where everything lives \u2014 pantry, fridge, garage, you decide.",
      actionLabel: "Create Location",
    },
    icons: { phosphor: "MapPin", sfSymbol: "mappin.and.ellipse", emoji: "📍" },
    detail: {
      omitRelations: {
        ingredients:
          "Derived through inventory, then product, then ingredient; the Contents table already lists what is stocked here.",
      },
      // The generic "No locations yet." reads oddly under "Sub-locations" —
      // a self-relation whose target label doesn't match the section title.
      hero: { breadcrumb: "parentId" },
      additionalSections: [
        {
          kind: "slot",
          id: "contents-valuation",
          title: "Valuation",
          placement: "supporting",
          explanationField: "valuation",
        },
        {
          kind: "slot",
          id: "ai-description",
          title: "AI description",
          placement: "supporting",
        },
        {
          kind: "relation",
          id: "plantings",
          title: "Plantings",
          relation: "plantings",
          filter: { descriptor: "locationId" },
          hideWhenEmpty: true,
          placement: "supporting",
        },
        {
          kind: "relation",
          id: "garden-entries",
          title: "Garden entries",
          relation: "garden-entries",
          filter: { descriptor: "locationId" },
          sort: { field: "observedOn", direction: "desc" },
          hideWhenEmpty: true,
          placement: "supporting",
        },
      ],
    },
    list: {
      savedViews: [
        {
          id: "undescribed",
          label: "No AI description",
          description: "Locations with photos that haven't been described yet",
          // `location_ai_description`'s own `expected` is "has a displayable
          // photo" (checks/location.ts) — describing a location with no photo
          // isn't possible, so without that gate this would select a backlog
          // nothing can drain.
          filters: [{ id: "dataGaps", value: ["location_ai_description"] }],
          problem: {
            key: "locationsWithoutAiDescription",
            title: "Missing AI Descriptions",
            description:
              "Locations with photos that haven't been analyzed by AI yet. Run backfill to generate descriptions for all.",
            emptyMessage: "All locations with photos have AI descriptions.",
          },
          // Both hidden by default on this table, so the view has to reveal them —
          // otherwise it selects rows on a signal nothing on screen explains.
          layout: {
            columnVisibility: { aiDescription: true, image: true },
          },
        },
        {
          id: "stale-recounts",
          label: "Overdue a recount",
          description: "Holding stock, not counted in 60 days (or ever)",
          // Inventory never auto-decrements, so nothing but a deliberate recount
          // restores a count's truth — an uncounted bin just drifts. Deliberately
          // looser than the 30-day tint the location page shows: that nudges, this
          // raises a row.
          filters: [
            { id: "inventoryEntries", value: "has" },
            { id: "lastBulkInventory", value: "60" },
          ],
          // Oldest recount first. Never-recounted bins do NOT lead: `buildOrderBy`
          // emits NULLS LAST in both directions, which is the house convention
          // (revisited and kept 2026-07 — empties are found with presence filters,
          // not by sort direction). The detector this replaced ordered `nulls
          // first`; that behaviour is gone deliberately rather than by accident,
          // and a one-column exception is exactly what the convention exists to
          // prevent. They are still fully IN the section — the `IS NULL` half of
          // the predicate is load-bearing — and the count includes them; they just
          // don't fill the card's sample.
          sort: [{ id: "lastBulkInventory", desc: false }],
          problem: {
            key: "staleLocations",
            title: "Locations overdue a recount",
            description:
              "Holding stock whose count hasn't been checked against the shelf in 60 days — or ever.",
            emptyMessage: "Every stocked location has been recounted recently.",
          },
          layout: {
            columnVisibility: {
              lastBulkInventory: true,
              inventoryEntries: true,
            },
          },
        },
        {
          id: "empty-leaves",
          label: "Empty",
          description: "Leaf locations holding nothing",
          // Both halves are required. Without `children: none` this matches every
          // shelf whose stock lives in its bins rather than directly on it, which
          // is most of the tree and none of the worklist.
          filters: [
            { id: "inventoryEntries", value: "none" },
            { id: "children", value: "none" },
          ],
          problem: {
            key: "emptyLocations",
            title: "Empty locations",
            description:
              "Leaf locations holding no stock — either not yet itemized, or genuinely empty.",
            emptyMessage: "No empty locations.",
          },
          layout: {
            columnVisibility: { children: true, inventoryEntries: true },
          },
        },
      ],
      read: {
        relations: ["product", "children", "parent", "inventoryEntries"],
        derived: ["valuation", "valuationLabel"],
        media: ["images", "displayImages"],
        quality: ["dataQuality"],
      },
      views: [
        { kind: "slot", id: "gallery", label: "Contents" },
        "table",
        { kind: "slot", id: "visualizations", label: "Visualizations" },
      ],
      extraActions: ["moveUnder"],
      links: [
        { label: "Arrange", path: "/locations/arrange" },
        { label: "Print labels", path: "/labels" },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true },
        validation: {
          read: z.string().describe("name of location"),
          create: z
            .string()
            .trim()
            .min(1, "Location name is required")
            .describe("name of location"),
          update: z
            .string()
            .trim()
            .min(1, "Location name is required")
            .describe("name of location")
            .optional(),
        },
      },
      {
        key: "aliases",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: { detail: true },
        validation: {
          read: z
            .array(z.string())
            .default([])
            .describe(
              "Alternate names for this location (searched + embedded)",
            ),
          create: z
            .array(z.string())
            .default([])
            .describe(
              "Alternate names for this location — searched alongside the name. Replaces the existing list when provided.",
            ),
          update: z.array(z.string()).optional(),
        },
      },
      {
        key: "tags",
        kind: "text-array",
        control: { kind: "specialized", renderer: "tag-list" },
        display: { detail: true },
        validation: {
          read: z
            .array(z.string())
            .optional()
            .describe(
              "Namespaced Collection tags assigned directly to this location",
            ),
          create: z
            .array(z.string())
            .describe("Tags assigned directly to this location")
            .optional(),
          update: z
            .array(z.string())
            .describe("Tags assigned directly to this location")
            .optional(),
        },
      },
      {
        key: "type",
        kind: "enum",
        // Auto-suggest is manifest-driven (`control.suggest`) now, not the
        // hand-rendered AI-suggest widget. A Product-linked location has no
        // form factor of its own; the server stores `furniture` for it when
        // the request omits `type`. `furniture` requires a `productId`.
        control: {
          kind: "select",
          options: selectControlOptions.locationType,
          suggest: { basis: ["name"] },
          initial: { value: "room" },
        },
        display: {
          list: true,
          detail: true,
          width: "sm",
          mobile: { slot: "subtitle", priority: 15 },
        },
        validation: {
          read: locationType,
          create: locationType.optional(),
          update: locationType.optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().trim().min(1).nullable().optional(),
          update: z.string().trim().min(1).nullable().optional(),
        },
      },
      {
        key: "productId",
        kind: "identifier",
        nullable: true,
        readKeyOverride: "product",
        reference: { entity: "product" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: null,
          create: productShortcode.nullable().optional(),
          update: productShortcode.nullable().optional(),
        },
      },
      {
        key: "parentId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "location" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: null,
          create: locationShortcode.nullable().optional(),
          update: locationShortcode.nullable().optional(),
        },
      },
      {
        // No editor `control`: the generic dialog shell renders the shared
        // photo-capture field itself for any intent whose roster includes
        // this key (`entity-edit-dialog-content.tsx`) — same convention as
        // meal's `pendingImageIds`.
        key: "pendingImageIds",
        kind: "identifier",
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: z.array(imageShortcode).optional(),
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "removeImageIds",
        kind: "identifier",
        reference: { entity: "image", multiple: true },
        validation: {
          read: null,
          create: null,
          update: z
            .array(imageShortcode)
            .optional()
            .describe(
              "Image ids to detach. Detaching DELETES the stored file when nothing else references it — there is no restore, and the id will not resolve again.",
            ),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        control: { kind: "specialized", renderer: "image-order" },
        provenance: {
          kind: "relation",
          sources: [{ entity: "image", relation: "images" }],
        },
        validation: {
          read: null,
          create: null,
          update: z
            .array(imageShortcode)
            .optional()
            .describe("existing image ids in display order; first = cover"),
        },
      },
      {
        key: "id",
        kind: "identifier",
        display: { detail: true },
        validation: {
          read: locationShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "product",
        kind: "json",
        nullable: true,
        labelOverride: "Is a",
        display: {
          list: true,
          labelPath: "product.name",
          renderer: { list: "product-link" },
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "product", relation: "product" }],
        },
        explanation: {
          ruleId: "location.installed-product",
          description:
            "The installed product is projected from this location's current product relationship.",
          readPath: "product",
          sourceDependencies: [{ path: "product", label: "Installed product" }],
        },
        validation: {
          read: locationIdentityProductOut.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "lastBulkInventory",
        kind: "timestamp",
        nullable: true,
        display: {
          list: true,
          detail: true,
          width: "sm",
          format: "timestamp",
          mobile: { slot: "meta", priority: 90 },
        },
        validation: {
          read: z.date().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "aiDescription",
        kind: "text",
        nullable: true,
        // Rendered (and regenerated) by the `ai-description` detail slot.
        // Read from the latest live `location-description` AiAnalysis; the
        // location row stores nothing.
        provenance: {
          kind: "derived",
          sources: [{ label: "Latest location-description AI analysis" }],
        },
        display: {
          list: true,
          listHidden: true,
          width: "lg",
          mobile: { slot: "meta", priority: 70 },
        },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, detail: false, standard: "image" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "images" }],
        },
        explanation: {
          ruleId: "location.images",
          description:
            "Location images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.",
          projections: {
            list: "displayImages",
            detail: "images",
            summary: "displayImages",
          },
          sourceDependencies: [
            { path: "displayImages", label: "Selected location images" },
          ],
        },
        validation: {
          read: z.array(imageOut),
          create: null,
          update: null,
        },
      },
      labelField("valuationLabel", "Inventory valuation"),
      {
        key: "valuation",
        kind: "json",
        nullable: true,
        display: {
          list: true,
          detail: false,
          labelPath: "valuationLabel",
          renderer: { list: "valuation-summary" },
        },
        provenance: { kind: "derived", sources: [{ entity: "location" }] },
        explanation: {
          ruleId: "location.direct-valuation",
          description:
            "Location valuation rolls up canonical inventory values; the list shows direct contents and the detail valuation includes descendant locations.",
          resolver: "locationValuation",
          projections: {
            list: "valuation.directValuation",
            detail: "valuation.totalValuation",
            summary: "valuation.directValuation",
          },
          sourceDependencies: [
            { path: "valuation.directItemCount", label: "Direct item count" },
            {
              path: "valuation.directPricedCount",
              label: "Priced direct items",
            },
            {
              path: "valuation.directUnpricedCount",
              label: "Unpriced direct items",
            },
            {
              path: "valuation.totalItemCount",
              label: "Total rolled-up item count",
            },
            { path: "valuation.total", label: "Rolled-up pricing coverage" },
          ],
        },
        validation: {
          read: locationValuation.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: z.date(),
          create: null,
          update: null,
        },
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
        specialized: "primary-key:LocationId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "aliases",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "tags",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
      "lastBulkInventory",
      { key: "parentId", reference: "location" },
      { key: "productId", reference: "product" },
      { key: "type", specialized: "enum:type" },
      "notes",
    ],
    create: [
      "name",
      "aliases",
      "tags",
      "type",
      "notes",
      "productId",
      "parentId",
      "pendingImageIds",
    ],
    update: [
      "name",
      "aliases",
      "tags",
      "type",
      "notes",
      "productId",
      "parentId",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: ["parentId"],
    audit: ["name", "aliases", "tags", "type", "parentId"],
    sort: {
      fields: [
        "createdAt",
        "updatedAt",
        "name",
        "type",
        "parent",
        "lastBulkInventory",
        "valuation",
        "inventoryEntries",
      ],
      computed: ["parent", "inventoryEntries"],
      groupable: ["type"],
      // The web list groups locations by their own `type` value, so no
      // `labelField` is needed — the field's own value is the label.
      grouping: {
        field: "type",
        nullGroupKey: LOCATION_UNSPECIFIED_GROUP_KEY,
      },
    },
    intents: {
      fields: {
        // Quick add: alternate names, collections, and photos are filled in
        // afterward from the location's own edit dialog (`full`, below).
        capture: ["name", "type", "parentId", "productId"],
        full: [
          "name",
          "aliases",
          "type",
          "notes",
          "productId",
          "parentId",
          "collections",
          "pendingImageIds",
          "removeImageIds",
          "imageOrder",
        ],
        identity: ["name", "aliases", "type", "productId"],
        parent: ["parentId"],
      },
      create: ["capture", "full"],
      update: ["full", "identity", "parent"],
      // `collections` is a pure editor-only pseudo field: no model field, no
      // stored column of its own — folded into `tags` at submit
      // (`locationBuildData`, `entities/editing/definitions.ts`) and unfolded
      // back out of the record's `tags` for edit-mode seeding.
      editorFields: ["collections"],
    },
    output: [
      "id",
      "name",
      "aliases",
      "tags",
      "type",
      "notes",
      "product",
      "lastBulkInventory",
      "aiDescription",
      "images",
      "valuation",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/location",
      export: "locationCreateInput",
    },
    update: { module: "@cubby/schemas/location", export: "locationUpdateData" },
    output: { module: "@cubby/schemas/location", export: "locationOut" },
    list: { module: "@cubby/schemas/location", export: "locationListItemOut" },
    detail: { module: "@cubby/schemas/location", export: "infLocation" },
  },
  storage: {
    indexes: [
      {
        name: "Location_name_key",
        on: [{ sql: "lower({name})" }],
        unique: true,
        where: "{deletedAt} IS NULL",
      },
      { on: ["name"] },
      { on: ["tags"], using: "gin" },
      { on: ["createdAt"] },
      { on: ["lastBulkInventory"] },
      { trigram: "name" },
      { on: ["type", "name"] },
      {
        name: "Location_name_active_idx",
        on: ["name"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "Location_type_active_idx",
        on: ["type"],
        where: "{deletedAt} IS NULL",
      },
    ],
    checks: [
      // `furniture` marks a Product-instance location (the bin or rack
      // itself). One direction only: a garden bed or planter may link a
      // Product and keep its own type, so `productId IS NOT NULL` does not
      // imply `furniture`.
      {
        name: "Location_furniture_product_check",
        sql: "{type} <> 'furniture' OR {productId} IS NOT NULL",
      },
    ],
    relations: {
      parent: { field: "parentId", relationName: "LocationToLocation" },
      children: { many: "location", relationName: "LocationToLocation" },
      inventoryEntries: { many: "inventoryEntry" },
      images: { many: "entityAttachment" },
      product: "productId",
      plantings: { many: "planting" },
      gardenEntries: { many: "gardenEntry" },
    },
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
        wire: { kind: "param", name: "lastBulkInventoryOlderThanDays" },
        placeholder: "Filter recounts...",
        options: [
          { value: "30", label: "Not counted in 30 days" },
          { value: "60", label: "Not counted in 60 days" },
          { value: "90", label: "Not counted in 90 days" },
        ],
        expandRef: {
          module: "~/entity/filter-behavior",
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
        deriveSchema: true,
        schemaDescription: "Filter by location name (substring)",
        stored: { columns: ["name", "aliases"] },
      },
      {
        columnId: "type",
        field: "itemTypeFilter",
        kind: "multiselect",
        placeholder: "Filter by type...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/location-fields",
          export: "locationType",
        },
        optionsRef: {
          module: "~/features/locations/location-icons",
          export: "locationTypeOptionsWithTheme",
        },
      },
      {
        columnId: "product",
        field: "productId",
        kind: "idMulti",
        placeholder: "Filter product...",
        optionsKey: "locationProducts",
        brandRef: { entity: "product" },
        nullable: { field: "productPresenceFilter", label: "product" },
      },
      {
        columnId: "parent",
        field: "parentId",
        kind: "idMulti",
        placeholder: "Filter parent...",
        brandRef: { entity: "location" },
        nullable: { field: "parentPresenceFilter", label: "parent" },
      },
      {
        columnId: "inventoryEntries",
        kind: "range",
        wire: {
          kind: "range",
          from: "directItemCountMin",
          to: "directItemCountMax",
        },
        placeholder: "Filter inventory...",
        options: [
          { value: "has", label: "Has items", meta: true },
          { value: "none", label: "(none)", meta: true },
          { value: "1", label: "1+ items" },
          { value: "2", label: "2+ items" },
          { value: "5", label: "5+ items" },
        ],
        expandRef: {
          module: "~/entity/filter-behavior",
          export: "resolveLocationItems",
        },
      },
      {
        columnId: "valuation",
        kind: "range",
        wire: { kind: "range", from: "valuationMin", to: "valuationMax" },
        placeholder: "Filter valuation...",
        options: [
          {
            value: "positive",
            label: "Positive basis",
            expand: { valuationMin: 0.01 },
          },
          {
            value: "zero",
            label: "Zero basis",
            expand: { valuationMin: 0, valuationMax: 0 },
          },
          {
            value: "negative",
            label: "Credit / negative",
            expand: { valuationMax: -0.01 },
          },
          {
            value: "gte100",
            label: "$100 and up",
            expand: { valuationMin: 100 },
          },
          {
            value: "gte500",
            label: "$500 and up",
            expand: { valuationMin: 500 },
          },
        ],
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
        brandRef: { entity: "ingredient" },
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
      key: "children",
      label: "Sub-locations",
      empty: "No sub-locations yet.",
      target: "location",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Location.parentId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Location.parentId", direction: "outgoing" }],
      },
    },
    {
      key: "inventory",
      label: "Inventory",
      target: "inventory",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "InventoryEntry.locationId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "InventoryEntry.locationId", direction: "outgoing" }],
      },
    },
    {
      key: "parent",
      label: "Parent location",
      target: "location",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Location.parentId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Location.parentId", direction: "incoming" }],
      },
    },
    {
      key: "product",
      label: "Product",
      target: "product",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Location.productId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Location.productId", direction: "incoming" }],
      },
    },
    {
      key: "ingredients",
      label: "Ingredients",
      target: "ingredient",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "InventoryEntry.locationId", direction: "incoming" },
          { edge: "InventoryEntry.productId", direction: "outgoing" },
          { edge: "Product.ingredientId", direction: "outgoing" },
        ],
      },
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
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "EntityAttachment.entityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.entityId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "plantings",
      label: "Plantings",
      target: "planting",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.locationId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Planting.locationId", direction: "outgoing" }],
      },
    },
    {
      key: "garden-entries",
      label: "Garden entries",
      target: "gardenEntry",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "GardenEntry.locationId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "GardenEntry.locationId", direction: "outgoing" }],
      },
    },
  ],
  search: "semantic",
  capabilities: {
    images: {
      storage: "gallery",
      displaySources: [
        {
          relationPath: ["product"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        { kind: "self", routeId: "location-self", choice: "primary" },
        {
          kind: "createRelated",
          routeId: "location-new-garden-entry",
          relationPath: ["garden-entries"],
          choice: {
            primary: { when: { field: "type", oneOf: ["bed", "planter"] } },
            otherwise: "alternate",
          },
          bindings: [
            { field: "locationId", from: "source-id" },
            { field: "kind", from: "constant", value: "note" },
            { field: "observedOn", from: "capture-date" },
          ],
        },
        { kind: "createSelf", routeId: "location-new", enabled: true },
      ],
      routing: {
        category: "home",
        candidateFields: ["name", "description"],
        temporalFields: [],
        lifecycleFilters: [],
        signals: {
          ocrFields: ["name", "description"],
          classifierLabels: ["closet", "shed"],
        },
        abstention: { minimumScore: 0.7, minimumMargin: 0.12 },
      },
    },
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["parentId"] },
    merge: false,
    dataQuality: {
      checks: [
        {
          id: "location_ai_description",
          facet: "content",
          weight: 1,
          label: "AI description",
          message: "No AI-generated description is recorded.",
        },
        {
          // A furniture location IS a Product instance; stock of that same
          // Product elsewhere counts the item twice (once as the place, once
          // as an inventory row).
          id: "location_furniture_counted",
          facet: "integrity",
          kind: "defect",
          weight: 2,
          scoreCap: 49,
          label: "Counted twice",
          message:
            "This furniture location's Product also has live inventory entries, so the item is counted twice.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/location/repository",
        export: "locationRepository",
      },
      search: "document",
    },
  },
});

import { defineEntity } from "./definition.js";
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
  route: { basePath: "locations" },
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
      hero: { breadcrumb: "parentId" },
      additionalSectionOverrides: [
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
      viewOverrides: [
        { kind: "slot", id: "gallery", label: "Contents" },
        "table",
        { kind: "slot", id: "visualizations", label: "Visualizations" },
      ],
      actionOverrides: ["moveUnder", "delete"],
      links: [
        { label: "Arrange", path: "/locations/arrange" },
        { label: "Photo pass", path: "/locations/photo-pass" },
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
        nullable: true,
        // Auto-suggest is manifest-driven (`control.suggest`) now, not the
        // hand-rendered AI-suggest widget; `type` still disappears once a
        // product link supplies the form factor — see `intents.fields` below.
        control: {
          kind: "select",
          options: selectControlOptions.locationType,
          suggest: { basis: ["name"] },
        },
        display: {
          list: true,
          detail: true,
          width: "sm",
          mobile: { slot: "subtitle", priority: 15 },
        },
        validation: {
          read: locationType.nullable(),
          create: locationType.nullable().optional(),
          update: locationType.nullable().optional(),
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
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        readKeyOverride: null,
        control: { kind: "specialized", renderer: "image-order" },
        provenance: {
          kind: "relation",
          sources: [{ entity: "image", relation: "images" }],
        },
        validation: {
          read: locationIdentityProductOut.nullable(),
          create: null,
          update: z.array(imageShortcode).optional(),
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
        display: { list: true },
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
        display: { list: true, detail: true },
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
        display: { list: true, detail: false },
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
      {
        key: "valuation",
        kind: "json",
        nullable: true,
        display: { list: true, detail: false },
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
      "aiDescription",
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
        deriveSchema: true,
        schemaDescription:
          "Filter to locations that do / don't have an AI-generated description.",
        stored: true,
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
        stored: { columns: ["name", "aiDescription", "aliases"] },
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
        brandRef: { entity: "product" },
        nullable: { field: "productPresenceFilter", label: "product" },
      },
      {
        columnId: "parent",
        field: "parentId",
        kind: "idMulti",
        placeholder: "Filter parent...",
        optionsKey: "parentLocation",
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
          module: "~/entities/filter-behavior",
          export: "resolveLocationItems",
        },
      },
      {
        columnId: "valuation",
        kind: "range",
        wire: { kind: "range", from: "valuationMin", to: "valuationMax" },
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
          { edge: "EntityAttachment.subjectEntityId", direction: "incoming" },
          { edge: "EntityAttachment.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityAttachment.imageId", direction: "incoming" },
          { edge: "EntityAttachment.subjectEntityId", direction: "outgoing" },
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
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: "gallery",
      displaySourceOverrides: [
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
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["parentId"] },
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete", "bulkUpdate"],
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
          id: "location_type",
          facet: "identity",
          weight: 1,
          label: "Type",
          message: "Location type is not recorded.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/location/entity-adapter",
        export: "locationEntityAdapter",
      },
      search: "document",
    },
  },
});

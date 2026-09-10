import { defineEntity } from "./definition.js";
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
import { oneOrMany } from "@cubby/schemas/pagination";
import { z } from "zod";
export const filterSchemas = {
  nameFilter: z
    .string()
    .optional()
    .describe("Filter by location name (substring)"),
  itemTypeFilter: oneOrMany(locationType).optional(),
};
export default defineEntity({
  key: "location",
  names: { singular: "Location", plural: "Locations" },
  route: { basePath: "locations" },
  table: "Location",
  identifiers: { brand: "LocationId", shortcode: "LOC-", legacy: "L-" },
  presentation: { titleField: "name" },
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
        control: { kind: "select", section: "classification" },
        display: { list: true, detail: true, detailOrder: 1 },
        validation: {
          read: locationType.nullable(),
          create: locationType.nullable().optional(),
          update: locationType.nullable().optional(),
        },
      },
      {
        key: "productId",
        kind: "identifier",
        nullable: true,
        label: "Is a",
        readKey: "product",
        reference: { entity: "product" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true, detailOrder: 2 },
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
        label: "Parent Location",
        readKey: null,
        reference: { entity: "location" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true, detailOrder: 3 },
        validation: {
          read: null,
          create: locationShortcode.nullable().optional(),
          update: locationShortcode.nullable().optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        label: "Pending Image IDs",
        readKey: null,
        reference: { entity: "image", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          read: null,
          create: z.array(imageShortcode).optional(),
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "removeImageIds",
        kind: "identifier",
        label: "Remove Image IDs",
        readKey: null,
        reference: { entity: "image", multiple: true },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "imageOrder",
        kind: "text",
        readKey: null,
        control: { kind: "specialized", renderer: "image-order" },
        validation: {
          read: locationIdentityProductOut.nullable(),
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        label: "Shortcode",
        display: { detail: true, detailOrder: 0 },
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
        label: "Last recount",
        display: { list: true, detail: true, detailOrder: 4 },
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
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, detail: true, columnId: "image" },
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
        display: { list: true, detail: true, columnId: "valuation" },
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
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:LocationId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      {
        key: "aliases",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      {
        key: "tags",
        default: "literal",
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
      "lastBulkInventory",
      { key: "parentId", reference: "location" },
      { key: "productId", reference: "product" },
      { key: "type", specialized: "enum:type" },
      "aiDescription",
      { key: "valuation", specialized: "json:valuation" },
    ],
    create: [
      "name",
      "aliases",
      "tags",
      "type",
      "productId",
      "parentId",
      "pendingImageIds",
    ],
    update: [
      "name",
      "aliases",
      "tags",
      "type",
      "productId",
      "parentId",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: ["parentId"],
    audit: ["name", "aliases", "tags", "type", "parentId"],
    output: [
      "id",
      "name",
      "aliases",
      "tags",
      "type",
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
        deriveSchema: true,
        schemaDescription: "Filter by location name (substring)",
      },
      {
        columnId: "type",
        field: "itemTypeFilter",
        kind: "multiselect",
        placeholder: "Filter by type...",
        deriveSchema: true,
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
        brandRef: { entity: "product", kind: "id" },
        nullable: { field: "productPresenceFilter", label: "product" },
      },
      {
        columnId: "parent",
        field: "parentId",
        kind: "idMulti",
        placeholder: "Filter parent...",
        optionsKey: "parentLocation",
        brandRef: { entity: "location", kind: "id" },
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
          { edge: "LocationImage.locationId", direction: "incoming" },
          { edge: "LocationImage.imageId", direction: "outgoing" },
        ],
      },
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
    bulkUpdate: { fields: ["parentId"] },
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete", "bulkUpdate"],
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
    },
  },
});

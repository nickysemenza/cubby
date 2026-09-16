import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  imageShortcode,
  ingredientShortcode,
  locationShortcode,
  plantingShortcode,
  productShortcode,
} from "../identifier-fields.js";
import { plantingStatus } from "@cubby/schemas/garden-fields";
import { imageOut } from "./field-primitives.js";
import { z } from "zod";

const optionalText = z.string().trim().min(1).nullable();
export default defineEntity({
  key: "planting",
  names: { singular: "Planting", plural: "Plantings" },
  route: { basePath: "plantings" },
  table: "Planting",
  identifiers: { brand: "PlantingId", shortcode: "PLT-" },
  presentation: {
    titleField: "displayName",
    domain: "house",
    description: "Crops growing now and planned for later.",
    emptyState: {
      title: "No plantings yet",
      description:
        "Record what is growing now or plan the next crop for one of your garden locations.",
    },
    icons: { lucide: "Sprout", sfSymbol: "leaf" },
  },
  model: {
    fields: [
      {
        key: "ingredientId",
        kind: "identifier",
        reference: { entity: "ingredient" },
        validation: {
          read: ingredientShortcode,
          create: ingredientShortcode,
          update: ingredientShortcode.optional(),
        },
      },
      {
        key: "sourceProductId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "product" },
        validation: {
          read: productShortcode.nullable(),
          create: productShortcode.nullable().default(null),
          update: productShortcode.nullable().optional(),
        },
      },
      {
        key: "locationId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "location" },
        validation: {
          read: locationShortcode.nullable(),
          create: locationShortcode.nullable().default(null),
          update: locationShortcode.nullable().optional(),
        },
      },
      {
        key: "intendedLocationId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "location" },
        validation: {
          read: locationShortcode.nullable(),
          create: locationShortcode.nullable().default(null),
          update: locationShortcode.nullable().optional(),
        },
      },
      {
        key: "parentPlantingId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "planting" },
        validation: {
          read: plantingShortcode.nullable(),
          create: null,
          update: null,
        },
      },
      {
        key: "status",
        kind: "enum",
        validation: {
          read: plantingStatus,
          create: plantingStatus.default("planned"),
          update: plantingStatus.optional(),
        },
      },
      {
        key: "variety",
        kind: "text",
        nullable: true,
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
        key: "quantity",
        kind: "text",
        nullable: true,
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
        key: "plannedWindow",
        kind: "text",
        nullable: true,
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
        key: "plannedDate",
        kind: "date",
        nullable: true,
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "sowedOn",
        kind: "date",
        nullable: true,
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "transplantedOn",
        kind: "date",
        nullable: true,
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "finishedOn",
        kind: "date",
        nullable: true,
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
        readKey: null,
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
        readKey: null,
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
        readKey: null,
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image", columnId: "image" },
        validation: { read: z.array(imageOut), create: null, update: null },
      },
      {
        // `"<ingredient name>[ · <variety>]"` — the canonical non-null title;
        // `variety` alone is nullable and cannot serve as the title field.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "id",
        kind: "identifier",
        validation: { read: plantingShortcode, create: null, update: null },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        validation: { read: z.date(), create: null, update: null },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        validation: { read: z.date(), create: null, update: null },
      },
      { key: "shortcode", kind: "text", readKey: null },
      { key: "deletedAt", kind: "timestamp", nullable: true, readKey: null },
    ],
    storage: [
      {
        key: "id",
        default: "generated",
        specialized: "primary-key:PlantingId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "ingredientId", reference: "ingredient" },
      { key: "sourceProductId", reference: "product" },
      { key: "locationId", reference: "location" },
      { key: "intendedLocationId", reference: "location" },
      { key: "parentPlantingId", reference: "planting" },
      {
        key: "status",
        specialized: "enum:status",
        default: "literal",
        defaultValue: "planned",
      },
      "variety",
      "quantity",
      "notes",
      "plannedWindow",
      "plannedDate",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "ingredientId",
      "sourceProductId",
      "locationId",
      "intendedLocationId",
      "status",
      "variety",
      "quantity",
      "notes",
      "plannedWindow",
      "plannedDate",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
      "pendingImageIds",
    ],
    update: [
      "ingredientId",
      "sourceProductId",
      "locationId",
      "intendedLocationId",
      "status",
      "variety",
      "quantity",
      "notes",
      "plannedWindow",
      "plannedDate",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: [],
    audit: ["status", "locationId"],
    sort: { fields: ["createdAt", "updatedAt"], default: "createdAt" },
    intents: {
      fields: {
        capture: ["ingredientId", "locationId", "status", "pendingImageIds"],
        full: [
          "ingredientId",
          "sourceProductId",
          "locationId",
          "intendedLocationId",
          "status",
          "variety",
          "quantity",
          "notes",
          "plannedWindow",
          "plannedDate",
          "sowedOn",
          "transplantedOn",
          "pendingImageIds",
        ],
      },
      create: ["capture", "full"],
      update: ["full"],
    },
    output: [
      "id",
      "ingredientId",
      "sourceProductId",
      "locationId",
      "intendedLocationId",
      "parentPlantingId",
      "status",
      "variety",
      "quantity",
      "notes",
      "plannedWindow",
      "plannedDate",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
      "images",
      "displayName",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/garden", export: "plantingCreateInput" },
    update: { module: "@cubby/schemas/garden", export: "plantingUpdateData" },
    output: { module: "@cubby/schemas/garden", export: "plantingOut" },
    list: { module: "@cubby/schemas/garden", export: "plantingListItemOut" },
  },
  // The initial garden list has no public filter vocabulary; lifecycle views
  // are served by the dedicated overview and history operations.
  filters: { audit: false, schema: null, descriptors: [] },
  relations: [
    {
      key: "ingredient",
      label: "Ingredient",
      target: "ingredient",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.ingredientId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Planting.ingredientId", direction: "incoming" }],
      },
    },
    {
      key: "source-product",
      label: "Source product",
      target: "product",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.sourceProductId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Planting.sourceProductId", direction: "incoming" }],
      },
    },
    {
      key: "location",
      label: "Current location",
      target: "location",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.locationId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Planting.locationId", direction: "incoming" }],
      },
    },
    {
      key: "intended-location",
      label: "Intended location",
      target: "location",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.intendedLocationId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Planting.intendedLocationId", direction: "incoming" }],
      },
    },
    {
      key: "parent-planting",
      label: "Parent planting",
      target: "planting",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.parentPlantingId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Planting.parentPlantingId", direction: "incoming" }],
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
          { edge: "PlantingImage.plantingId", direction: "incoming" },
          { edge: "PlantingImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "PlantingImage.imageId", direction: "incoming" },
          { edge: "PlantingImage.plantingId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "location-history",
      label: "Location history",
      target: "location",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "PlantingLocationPeriod.plantingId", direction: "incoming" },
          { edge: "PlantingLocationPeriod.locationId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "PlantingLocationPeriod.locationId", direction: "incoming" },
          { edge: "PlantingLocationPeriod.plantingId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "location-history-entries",
      label: "Location history entries",
      target: "gardenEntry",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "PlantingLocationPeriod.plantingId", direction: "incoming" },
          {
            edge: "PlantingLocationPeriod.sourceGardenEntryId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "PlantingLocationPeriod.sourceGardenEntryId",
            direction: "incoming",
          },
          { edge: "PlantingLocationPeriod.plantingId", direction: "outgoing" },
        ],
      },
    },
  ],
  // `displayName` is a non-null projected title (ingredient + variety), so
  // Cmd-K / `/search` can index plantings like every other named entity.
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: "gallery",
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/garden/entity-adapters",
        export: "plantingEntityAdapter",
      },
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: {
          module: "~/server/repo/shortcode-resolver",
          export: "resolveLiveShortcode",
        },
      },
      filters: null,
      search: { projection: null, semanticText: null, dependentRefresh: null },
    },
  },
});

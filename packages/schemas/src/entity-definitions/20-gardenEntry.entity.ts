import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  gardenEntryShortcode,
  imageShortcode,
  locationShortcode,
  plantingShortcode,
} from "../identifier-fields.js";
import { gardenEntryKind } from "@cubby/schemas/garden-fields";
import { imageOut } from "./field-primitives.js";
import { z } from "zod";

const optionalText = z.string().trim().min(1).nullable();
export default defineEntity({
  key: "gardenEntry",
  names: { singular: "Garden Entry", plural: "Garden Entries" },
  route: { basePath: "garden-entries", list: null, detail: null },
  table: "GardenEntry",
  identifiers: { brand: "GardenEntryId", shortcode: "GDE-" },
  presentation: {
    titleField: "displayName",
    domain: "house",
    description: "Dated garden photos, observations, and harvests.",
    emptyState: {
      title: "No garden entries yet",
      description:
        "Add a dated observation, harvest, or photo batch to keep a simple garden history.",
    },
    icons: { lucide: "CalendarDays", sfSymbol: "text.badge.plus" },
  },
  model: {
    fields: [
      {
        key: "locationId",
        kind: "identifier",
        reference: { entity: "location" },
        validation: {
          read: locationShortcode,
          create: locationShortcode,
          update: locationShortcode.optional(),
        },
      },
      {
        key: "plantingId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "planting" },
        validation: {
          read: plantingShortcode.nullable(),
          create: plantingShortcode.nullable().default(null),
          update: plantingShortcode.nullable().optional(),
        },
      },
      {
        key: "kind",
        kind: "enum",
        validation: {
          read: gardenEntryKind,
          create: gardenEntryKind.default("observation"),
          update: gardenEntryKind.optional(),
        },
      },
      {
        key: "observedOn",
        kind: "date",
        validation: {
          read: plainDate,
          create: plainDate,
          update: plainDate.optional(),
        },
      },
      {
        key: "note",
        kind: "text",
        nullable: true,
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
        key: "harvestAmount",
        kind: "text",
        nullable: true,
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
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
        validation: { read: z.array(imageOut), create: null, update: null },
      },
      {
        // `"<Kind> · <YYYY-MM-DD> · <location name>"` — gardenEntry has no
        // name column and `note` is nullable, so this is the canonical
        // non-null title.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "id",
        kind: "identifier",
        validation: { read: gardenEntryShortcode, create: null, update: null },
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
        specialized: "primary-key:GardenEntryId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "locationId", reference: "location" },
      { key: "plantingId", reference: "planting" },
      {
        key: "kind",
        specialized: "enum:kind",
        default: "literal",
        defaultValue: "observation",
      },
      "observedOn",
      "note",
      "harvestAmount",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "locationId",
      "plantingId",
      "kind",
      "observedOn",
      "note",
      "harvestAmount",
      "pendingImageIds",
    ],
    update: [
      "locationId",
      "plantingId",
      "kind",
      "observedOn",
      "note",
      "harvestAmount",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
    ],
    bulk: [],
    audit: [
      "locationId",
      "plantingId",
      "kind",
      "observedOn",
      "note",
      "harvestAmount",
    ],
    sort: { fields: ["observedOn", "createdAt"], default: "observedOn" },
    intents: {
      fields: {
        capture: ["locationId", "observedOn", "note", "pendingImageIds"],
        full: [
          "locationId",
          "plantingId",
          "kind",
          "observedOn",
          "note",
          "harvestAmount",
          "pendingImageIds",
        ],
      },
      create: ["capture", "full"],
      update: ["full"],
    },
    output: [
      "id",
      "locationId",
      "plantingId",
      "kind",
      "observedOn",
      "note",
      "harvestAmount",
      "images",
      "displayName",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/garden",
      export: "gardenEntryCreateInput",
    },
    update: {
      module: "@cubby/schemas/garden",
      export: "gardenEntryUpdateData",
    },
    output: { module: "@cubby/schemas/garden", export: "gardenEntryOut" },
    list: { module: "@cubby/schemas/garden", export: "gardenEntryListItemOut" },
  },
  // Bed/planting history filters live on `garden.entries`, not generic lists.
  filters: { audit: false, schema: null, descriptors: [] },
  relations: [
    {
      key: "location",
      label: "Location",
      target: "location",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "GardenEntry.locationId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "GardenEntry.locationId", direction: "incoming" }],
      },
    },
    {
      key: "planting",
      label: "Planting",
      target: "planting",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "GardenEntry.plantingId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "GardenEntry.plantingId", direction: "incoming" }],
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
          { edge: "GardenEntryImage.gardenEntryId", direction: "incoming" },
          { edge: "GardenEntryImage.imageId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "GardenEntryImage.imageId", direction: "incoming" },
          { edge: "GardenEntryImage.gardenEntryId", direction: "outgoing" },
        ],
      },
    },
  ],
  // `displayName` is a non-null projected title (kind · date · location), so
  // Cmd-K / `/search` can index garden entries like every other named entity.
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
        export: "gardenEntryEntityAdapter",
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

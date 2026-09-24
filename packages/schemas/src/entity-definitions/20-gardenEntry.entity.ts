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
  route: {
    basePath: "garden-entries",
  },
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
      actionLabel: "New Garden Entry",
    },
    icons: {
      phosphor: "CalendarDots",
      sfSymbol: "text.badge.plus",
      emoji: "📓",
    },
    detail: {},
    list: {
      timeline: { fields: ["observedOn"] },
    },
  },
  model: {
    fields: [
      {
        key: "locationId",
        kind: "identifier",
        reference: { entity: "location" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
        validation: {
          read: locationShortcode,
          create: locationShortcode,
          update: locationShortcode.optional(),
        },
      },
      {
        key: "plantingIds",
        kind: "identifier",
        reference: {
          entity: "planting",
          multiple: true,
          scope: [
            { sourceField: "locationId", targetField: "locationId" },
            { sourceField: "observedOn", targetField: "activeOn" },
          ],
        },
        control: { kind: "specialized", renderer: "entity-multi-select" },
        validation: {
          read: z.array(plantingShortcode),
          create: z.array(plantingShortcode).default([]),
          update: z.array(plantingShortcode).optional(),
        },
      },
      {
        key: "kind",
        kind: "enum",
        control: {
          kind: "select",
          suggest: { basis: ["harvestAmount", "note"] },
          options: [
            { value: "note", label: "Note" },
            { value: "harvest", label: "Harvest" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: gardenEntryKind,
          create: gardenEntryKind.default("note"),
          update: gardenEntryKind.optional(),
        },
      },
      {
        key: "observedOn",
        kind: "date",
        control: { kind: "date", initial: "today" },
        display: {
          list: true,
          detail: true,
          format: "plainDate",
        },
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
        control: { kind: "textarea" },
        display: { list: true, detail: true },
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
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
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
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "images",
        kind: "json",
        display: { list: true, standard: "image" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "image", relation: "images" }],
        },
        explanation: {
          ruleId: "gardenEntry.images",
          description:
            "Garden entry images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.",
          projections: {
            list: "displayImages",
            detail: "images",
            summary: "displayImages",
          },
          sourceDependencies: [
            { path: "displayImages", label: "Selected garden entry images" },
          ],
        },
        validation: { read: z.array(imageOut), create: null, update: null },
      },
      {
        key: "locationName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "plantings",
        kind: "identifier",
        reference: { entity: "planting", multiple: true },
        display: { list: true, detail: true },
        validation: {
          read: z.array(z.object({ id: plantingShortcode, name: z.string() })),
          create: null,
          update: null,
        },
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
        specialized: "primary-key:GardenEntryId",
      },
      { key: "shortcode", specialized: "shortcode" },
      { key: "locationId", reference: "location" },
      {
        key: "kind",
        specialized: "enum:kind",
        defaultValue: "note",
      },
      "observedOn",
      "note",
      "harvestAmount",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "locationId",
      "plantingIds",
      "kind",
      "observedOn",
      "note",
      "harvestAmount",
      "pendingImageIds",
    ],
    update: [
      "locationId",
      "plantingIds",
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
      "plantingIds",
      "kind",
      "observedOn",
      "note",
      "harvestAmount",
    ],
    sort: {
      fields: ["observedOn", "createdAt", "updatedAt", "kind"],
    },
    intents: {
      fields: {
        capture: ["locationId", "observedOn", "note", "pendingImageIds"],
        full: [
          "locationId",
          "plantingIds",
          "kind",
          "observedOn",
          "note",
          "harvestAmount",
          "pendingImageIds",
          "removeImageIds",
          "imageOrder",
        ],
      },
      create: ["capture", "full"],
      update: ["full"],
    },
    output: [
      "id",
      "locationId",
      "plantingIds",
      "kind",
      "observedOn",
      "note",
      "harvestAmount",
      "images",
      "displayName",
      "locationName",
      "plantings",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/garden-entry",
      export: "gardenEntryCreateInput",
    },
    update: {
      module: "@cubby/schemas/garden-entry",
      export: "gardenEntryUpdateData",
    },
    output: { module: "@cubby/schemas/garden-entry", export: "gardenEntryOut" },
    list: {
      module: "@cubby/schemas/garden-entry",
      export: "gardenEntryListItemOut",
    },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/garden-entry",
      export: "gardenEntryFilterFields",
    },
    descriptors: [
      {
        columnId: "kind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        options: [
          { value: "note", label: "Note" },
          { value: "harvest", label: "Harvest" },
        ],
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "observedOn",
        kind: "range",
        placeholder: "Filter by observation date...",
        deriveSchema: true,
        stored: true,
        range: {
          kind: "date",
          describe: {
            lower: "Inclusive lower bound on observation date",
            upper: "Inclusive upper bound on observation date",
          },
        },
      },
      {
        columnId: "locationId",
        kind: "idMulti",
        placeholder: "Filter by location...",
        brandRef: { entity: "location" },
      },
      {
        columnId: "plantingId",
        kind: "idMulti",
        placeholder: "Filter by planting...",
        brandRef: { entity: "planting" },
      },
      {
        // A planting's journal: its own entries plus whole-location entries
        // observed during one of its confirmed location periods.
        columnId: "journalPlantingId",
        kind: "id",
        placeholder: "Journal for planting...",
        brandRef: { entity: "planting" },
        urlOnly: true,
      },
    ],
  },
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
      key: "plantings",
      label: "Plantings",
      target: "planting",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "GardenEntryPlanting.gardenEntryId", direction: "incoming" },
          { edge: "GardenEntryPlanting.plantingId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "GardenEntryPlanting.plantingId", direction: "incoming" },
          { edge: "GardenEntryPlanting.gardenEntryId", direction: "outgoing" },
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
  ],
  // `displayName` is a non-null projected title (kind · date · location), so
  // Cmd-K / `/search` can index garden entries like every other named entity.
  search: { enabled: true },
  capabilities: {
    auditable: true,
    timeline: "default",
    images: {
      storage: "gallery",
      ingress: [
        { kind: "self", routeId: "garden-entry-self" },
        {
          kind: "createSelf",
          routeId: "garden-entry-new",
          enabled: true,
          bindings: [
            { field: "observedOn", from: "capture-date" },
            { field: "kind", from: "constant", value: "note" },
          ],
        },
      ],
      routing: {
        category: "plants",
        candidateFields: ["note"],
        temporalFields: ["observedOn"],
        lifecycleFilters: [],
        signals: { ocrFields: ["note"], classifierLabels: ["garden"] },
        abstention: { minimumScore: 0.72, minimumMargin: 0.12 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete"],
    dataQuality: {
      checks: [
        {
          id: "garden_entry_note",
          facet: "content",
          weight: 1,
          label: "Note",
          message: "No note is recorded for this entry.",
        },
        {
          id: "garden_entry_harvest_amount",
          facet: "content",
          weight: 1,
          label: "Harvest amount",
          message: "No harvest amount is recorded for this entry.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/garden/entity-adapters",
        export: "gardenEntryEntityAdapter",
      },
      filters: null,
    },
  },
});

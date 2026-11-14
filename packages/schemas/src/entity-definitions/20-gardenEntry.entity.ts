import { defineEdge } from "./edges";
import { galleryImagesField, galleryWriteFields } from "./image-fields";
import { idField, readOnly, timestampField } from "./field-policy";
import { imageDescriptionInputs } from "./image-description-inputs";
import { defineEntity, defineEntityModel } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  gardenEntryShortcode,
  locationShortcode,
  plantingShortcode,
} from "../identifier-fields.js";
import { gardenEntryKind } from "@cubby/schemas/garden-fields";
import { imageOut } from "./field-primitives.js";
import { z } from "zod";

const optionalText = z.string().trim().min(1).nullable();
export const { definition, readSchemas } = defineEntityModel({
  key: "gardenEntry",
  edges: [
    defineEdge({
      key: "gardenEntry/EntityAttachment.entityId",
      from: "row:EntityAttachment",
      to: "gardenEntry",
      cardinality: "one",
      inverse: {
        key: "gardenEntry.incoming.EntityAttachment.entityId",
        from: "gardenEntry",
        to: "row:EntityAttachment",
        cardinality: "many",
      },
      storage: {
        kind: "foreign-key",
        column: "EntityAttachment.entityId",
        constrained: true,
        partition: {
          column: "EntityAttachment.entityKind",
          value: "gardenEntry",
        },
      },
      ownership: {
        kind: "identity",
        column: "EntityAttachment.entityId",
      },
      fromEnd: {
        role: "reference",
        label: "target",
        description: "The referenced record.",
        liveness: {
          kind: "must-target-live",
        },
      },
      toEnd: {
        role: "media",
        label: "garden journal photos",
        description: "A photo attached to this garden journal entry.",
        liveness: {
          kind: "must-target-live",
        },
      },
      policies: {
        from: {
          delete: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
        to: {
          delete: {
            kind: "disposition",
            disposition: {
              code: "soft-delete-association",
              effect: "soft-delete",
              description:
                "Garden entry image associations are removed with the entry.",
            },
            handler: null,
            order: 0,
          },
          merge: {
            kind: "unsupported",
            reason: "This operation is not exposed for this endpoint.",
          },
        },
      },
    }),
  ],

  names: { singular: "Garden Entry", plural: "Garden Entries" },
  route: {
    basePath: "garden-entries",
  },
  table: "GardenEntry",
  identifiers: { brand: "GardenEntryId", shortcode: "GDE-" },
  presentation: {
    searchFacts: ["observedOn", "kind"],
    titleField: "displayName",
    domain: "garden",
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
    detail: {
      summary: [
        {
          kind: "fields",
          id: "observation",
          title: "Observation",
          fields: ["observedOn", "kind"],
        },
        {
          kind: "records",
          id: "location",
          title: "Location",
          viewKey: "relation:location",
        },
        {
          kind: "records",
          id: "plantings",
          title: "Plantings",
          viewKey: "relation:plantings",
        },
        {
          kind: "fields",
          id: "harvest",
          title: "Harvest",
          fields: ["harvestAmount"],
        },
        {
          kind: "fields",
          id: "observation-note",
          title: "Observation note",
          fields: ["notes"],
        },
        {
          kind: "records",
          id: "evidence",
          title: "Evidence",
          viewKey: "relation:images",
        },
      ],

      activityRelations: [
        { relation: "plantings", dateField: "sowedOn" },
        { relation: "images", dateField: "capturedAt" },
      ],
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Record",
          fields: [
            "locationId",
            "kind",
            "observedOn",
            "notes",
            "harvestAmount",
          ],
        },
        {
          kind: "fields",
          id: "coverage",
          title: "Coverage and summaries",
          fields: ["plantings"],
        },
      ],
    },
    list: {
      rail: [{ field: "observedOn" }],
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
        display: {
          mobile: { slot: "subtitle", priority: 10 },
          columnGroup: "Observation",
        },
        validation: {
          read: locationShortcode,
          create: locationShortcode,
          update: locationShortcode.optional(),
        },
      },
      {
        display: { detail: false, list: false },
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
          suggest: {
            basis: ["harvestAmount", "notes"],
            rules: [
              `Choose harvest when a harvest amount is present; otherwise choose note for an observation or photo journal entry.`,
            ],
          },
          options: [
            {
              value: "note",
              label: "Note",
              glyph: {
                phosphor: "NotePencil",
                sfSymbol: "square.and.pencil",
              },
              description: "A note, observation, or photo record",
            },
            {
              value: "harvest",
              label: "Harvest",
              color: "positive",
              glyph: { phosphor: "Basket", sfSymbol: "basket" },
              description: "A record of gathered produce",
            },
          ],
        },
        display: {
          mobile: { slot: "meta", priority: 20 },
          columnGroup: "Observation",
          optionRole: "category",
          optionColor: "domain-garden",
        },
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
        display: { columnGroup: "Observation", format: "plainDate" },
        validation: {
          read: plainDate,
          create: plainDate,
          update: plainDate.optional(),
        },
      },
      {
        key: "notes",
        // Stored and sent as `notes`; a garden entry still reads as one "Note".
        label: "Note",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { columnGroup: "Observation", width: "xl" },
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
        display: {
          mobile: { slot: "meta", priority: 30 },
          columnGroup: "Plantings & harvest",
          columnLabel: "Harvest",
        },
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      ...galleryWriteFields(),
      galleryImagesField("gardenEntry", "Garden entry", z.array(imageOut)),
      {
        display: { detail: false, list: false },
        key: "locationName",
        kind: "text",
        validation: readOnly(z.string()),
      },
      {
        key: "plantings",
        kind: "identifier",
        reference: { entity: "planting", multiple: true },
        display: { columnGroup: "Plantings & harvest" },
        validation: readOnly(
          z.array(z.object({ id: plantingShortcode, name: z.string() })),
        ),
      },
      {
        display: { detail: false, list: false },
        // `"<Kind> · <YYYY-MM-DD> · <location name>"` — gardenEntry has no
        // name column and `notes` is nullable, so this is the canonical
        // non-null title.
        key: "displayName",
        kind: "text",
        validation: readOnly(z.string()),
      },
      idField(gardenEntryShortcode),
      timestampField("createdAt", { detail: false, list: false }),
      timestampField("updatedAt", { detail: false, list: false }),
      { output: false, key: "shortcode", kind: "text" },
      { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:GardenEntryId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "locationId",
      {
        key: "kind",
        specialized: "enum:kind",
        defaultValue: "note",
      },
      "observedOn",
      "notes",
      "harvestAmount",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],

    rows: {
      // The plantings whose journal holds the entry: its own live planting
      // links, or for a whole-area entry (no planting links), every planting
      // at its location whose active window holds its observed day.
      journalPlantings: {
        label: "Journal plantings",
        repository: { planting: { reference: "planting" } },
      },
    },
    derived: {
      plantingId: { via: "plantings" },
      journalPlantingId: { via: "journalPlantings.planting" },
    },
    sort: {
      fields: ["observedOn", "createdAt", "updatedAt", "kind"],
    },
    intents: {
      fields: {
        capture: ["locationId", "observedOn", "notes", "pendingImageIds"],
        full: [
          "locationId",
          "plantingIds",
          "kind",
          "observedOn",
          "notes",
          "harvestAmount",
          "pendingImageIds",
          "removeImageIds",
          "imageOrder",
        ],
      },
      create: ["full", "capture"],
      update: ["full"],
    },
  },
  fields: {
    list: {
      module: "@cubby/schemas/garden-entry-raw-read",
      export: "rawGardenEntryListItemOut",
    },
  },
  storage: {
    indexes: [{ on: ["observedOn"] }],
    relations: {
      location: "locationId",
      images: { many: "entityAttachment" },
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
        deriveSchema: true,
        placeholder: "Filter by location...",
        brandRef: { entity: "location" },
      },
      {
        columnId: "plantingId",
        kind: "idMulti",
        placeholder: "Filter by planting...",
        brandRef: { entity: "planting" },
        deriveSchema: true,
      },
      {
        // A planting's journal: its own entries plus whole-location entries
        // observed at its current location during its active window.
        columnId: "journalPlantingId",
        kind: "idMulti",
        placeholder: "Journal for planting...",
        brandRef: { entity: "planting" },
      },
    ],
  },

  // `displayName` is a non-null projected title (kind · date · location), so
  // Cmd-K / `/search` can index garden entries like every other named entity.
  // Related rows the search document reads (ADR 0021).
  search: {
    mode: "semantic",
    inputs: [
      ...imageDescriptionInputs("gardenEntry"),

      {
        table: "Planting",
        match: { id: "id" },
        columns: ["plantId", "deletedAt"],
        path: [
          {
            table: "EntityLink",
            from: "toEntityId",
            to: "fromEntityId",
            where: { kind: "gardenEntryPlanting" },
          },
        ],
      },
      {
        table: "Plant",
        match: { id: "id" },
        columns: ["name", "gardenGuideKey", "deletedAt"],
        path: [
          { table: "Planting", from: "plantId", to: "id" },
          {
            table: "EntityLink",
            from: "toEntityId",
            to: "fromEntityId",
            where: { kind: "gardenEntryPlanting" },
          },
        ],
      },

      { table: "Location", match: { id: "locationId" } },
      {
        table: "EntityLink",
        match: { fromEntityId: "id" },
        where: { kind: "gardenEntryPlanting" },
      },
    ],
  },
  capabilities: {
    timeline: "default",
    images: {
      storage: "gallery",
      // A note without its own photo shows the bed it was written about.
      displaySources: [{ relationPath: ["location"] }],
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
        candidateFields: ["notes"],
        temporalFields: ["observedOn"],
        lifecycleFilters: [],
        signals: { ocrFields: ["notes"], classifierLabels: ["garden"] },
        abstention: { minimumScore: 0.72, minimumMargin: 0.12 },
      },
    },
    delete: { mode: "soft", bulk: true },
    merge: false,
    classificationPolicies: [
      {
        classifier: "kind",
        fields: [
          {
            field: "notes",
            byValue: { note: "required" },
            otherwise: "unknown",
            gap: "garden_entry_note",
          },
          {
            field: "harvestAmount",
            byValue: { harvest: "required" },
            otherwise: "unknown",
            gap: "garden_entry_harvest_amount",
          },
        ],
      },
    ],
    dataQuality: {
      checks: [
        {
          id: "garden_entry_note",
          satisfiedLabel: "Note recorded",
          placement: { field: "notes" },
          facet: "content",
          label: "Note",
          message: "No note is recorded for this entry.",
        },
        {
          id: "garden_entry_harvest_amount",
          satisfiedLabel: "Harvest amount recorded",
          placement: { field: "harvestAmount" },
          facet: "content",
          label: "Harvest amount",
          message: "No harvest amount is recorded for this entry.",
        },
      ],
    },
  },
  extensions: {
    relatednessSignals: [
      { kind: "semantic", label: "Similar meaning", weight: 1, limit: 8 },
    ],
    ports: {
      repository: {
        module: "~/server/domains/garden/repo/repository",
        export: "gardenEntryRepository",
      },
      filters: null,
    },
  },
});

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r.field("locationId").named("location", "Location"),
        "location.garden-entries",
      ),
      r.declare(
        r
          .link("gardenEntryPlanting", "outgoing")
          .named("plantings", "Plantings"),
        "planting.entries",
      ),
      r.declare(r.images(), "image.gardenEntry.images"),
    ],
  }),
  readSchemas,
);

import { imageDescriptionInputs } from "./image-description-inputs";
import { automaticFields } from "./automatic-fields";
import { imageAssociationStorage } from "./image-associations";
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
      timeline: { fields: ["observedOn"] },
    },
  },
  model: {
    stored: { automaticFields: automaticFields("gardenEntry", "GardenEntry") },
    fields: [
      {
        key: "locationId",
        kind: "identifier",
        reference: { entity: "location" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { columnGroup: "Observation" },
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
              glyph: { phosphor: "NotePencil", sfSymbol: "square.and.pencil" },
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
        labelOverride: "Note",
        kind: "text",
        nullable: true,
        control: { kind: "textarea" },
        display: { columnGroup: "Observation" },
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
        display: { columnGroup: "Plantings & harvest", columnLabel: "Harvest" },
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
        semanticRole: "attachment",
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
        display: { detail: false, standard: "image" },
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
        display: { detail: false, list: false },
        key: "locationName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "plantings",
        kind: "identifier",
        reference: { entity: "planting", multiple: true },
        display: { columnGroup: "Plantings & harvest" },
        validation: {
          read: z.array(z.object({ id: plantingShortcode, name: z.string() })),
          create: null,
          update: null,
        },
      },
      {
        display: { detail: false, list: false },
        // `"<Kind> · <YYYY-MM-DD> · <location name>"` — gardenEntry has no
        // name column and `notes` is nullable, so this is the canonical
        // non-null title.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: { read: gardenEntryShortcode, create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "createdAt",
        kind: "timestamp",
        validation: { read: z.date(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
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
      "notes",
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
      "notes",
      "harvestAmount",
      "pendingImageIds",
    ],
    update: [
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
    audit: [
      "locationId",
      "plantingIds",
      "kind",
      "observedOn",
      "notes",
      "harvestAmount",
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
    output: [
      "id",
      "locationId",
      "plantingIds",
      "kind",
      "observedOn",
      "notes",
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
        // observed during one of its confirmed location periods.
        columnId: "journalPlantingId",
        kind: "idMulti",
        placeholder: "Journal for planting...",
        brandRef: { entity: "planting" },
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
          {
            edge: "EntityLink[gardenEntryPlanting].from",
            direction: "incoming",
          },
          { edge: "EntityLink[gardenEntryPlanting].to", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "EntityLink[gardenEntryPlanting].to", direction: "incoming" },
          {
            edge: "EntityLink[gardenEntryPlanting].from",
            direction: "outgoing",
          },
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
  ],
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
      storage: imageAssociationStorage.shape.gardenEntry.value,
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
          weight: 1,
          label: "Note",
          message: "No note is recorded for this entry.",
        },
        {
          id: "garden_entry_harvest_amount",
          satisfiedLabel: "Harvest amount recorded",
          placement: { field: "harvestAmount" },
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
        module: "~/server/domains/garden/repo/repository",
        export: "gardenEntryRepository",
      },
      filters: null,
    },
  },
});

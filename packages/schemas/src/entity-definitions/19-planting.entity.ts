import { defineEntity } from "./definition.js";
import { plainDate } from "@cubby/schemas/base-entity";
import {
  locationShortcode,
  plantShortcode,
  plantingShortcode,
  productShortcode,
  taskShortcode,
} from "../identifier-fields.js";
import { plantingOutcome, plantingStatus } from "@cubby/schemas/garden-fields";
import { z } from "zod";

const optionalText = z.string().trim().min(1).nullable();
export default defineEntity({
  key: "planting",
  names: { singular: "Planting", plural: "Plantings" },
  route: {
    basePath: "plantings",
    create: "dialog",
    list: true,
    detail: true,
  },
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
      actionLabel: "New Planting",
    },
    icons: { lucide: "Sprout", sfSymbol: "leaf", emoji: "🌱" },
    detail: {
      variant: "journal",
      hero: {
        chip: "status",
      },
      sections: [
        {
          kind: "relation",
          id: "garden-history",
          title: "Journal",
          relation: "entries",
          filter: { descriptor: "journalPlantingId" },
          prefill: { field: "plantingIds" },
          columns: [
            "kind",
            "observedOn",
            "locationId",
            "note",
            "harvestAmount",
          ],
          sort: { field: "observedOn", direction: "desc" },
        },
        {
          kind: "fields",
          id: "overview",
          title: "Planting details",
          placement: "supporting",
          fields: [
            "plantId",
            "status",
            "outcome",
            "locationId",
            "sourceProductId",
            "quantity",
            "plannedWindow",
            "sowedOn",
            "transplantedOn",
            "finishedOn",
            "notes",
            "taskId",
            "expectedHarvest",
            "guideSowWindow",
            "guideTransplantWindow",
          ],
        },
      ],
    },
    list: {
      views: ["table", "timeline"],
      actions: ["delete"],
      timeline: {
        fields: [
          "sowedOn",
          "transplantedOn",
          "expectedHarvestStart",
          "finishedOn",
        ],
        lifecycle: {
          start: ["sowedOn", "transplantedOn"],
          milestones: ["transplantedOn", "expectedHarvestStart"],
          end: "finishedOn",
        },
      },
    },
  },
  model: {
    fields: [
      {
        key: "plantId",
        kind: "identifier",
        reference: { entity: "plant" },
        label: "Plant",
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
        validation: {
          read: plantShortcode,
          create: plantShortcode,
          update: plantShortcode.optional(),
        },
      },
      {
        key: "outcome",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: [
            { value: "succeeded", label: "Succeeded" },
            { value: "failed", label: "Failed" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: plantingOutcome.nullable(),
          create: plantingOutcome.nullable().default(null),
          update: plantingOutcome.nullable().optional(),
        },
      },
      {
        key: "sourceProductId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "product" },
        label: "Seed source",
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
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
        label: "Location",
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: true, detail: true },
        validation: {
          read: locationShortcode.nullable(),
          create: locationShortcode.nullable().default(null),
          update: locationShortcode.nullable().optional(),
        },
      },
      {
        key: "taskId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "task" },
        label: "Task",
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: taskShortcode.nullable(),
          create: taskShortcode.nullable().default(null),
          update: taskShortcode.nullable().optional(),
        },
      },
      {
        key: "status",
        kind: "enum",
        control: {
          kind: "select",
          suggest: { basis: ["transplantedOn", "finishedOn"] },
          options: [
            { value: "planned", label: "Planned" },
            { value: "growing", label: "Growing" },
            { value: "finished", label: "Finished" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: plantingStatus,
          create: plantingStatus.default("planned"),
          update: plantingStatus.optional(),
        },
      },
      {
        key: "quantity",
        kind: "text",
        nullable: true,
        control: { kind: "text" },
        display: { detail: true },
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
        control: { kind: "textarea" },
        display: { detail: true },
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
        label: "Planned window",
        control: { kind: "text" },
        display: { detail: true },
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
        key: "sowedOn",
        kind: "date",
        nullable: true,
        label: "Sowed",
        control: { kind: "date" },
        display: {
          list: true,
          detail: true,
          format: "plainDate",
        },
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
        label: "Transplanted",
        control: { kind: "date" },
        display: { list: true, detail: true, format: "plainDate" },
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
        label: "Finished",
        control: { kind: "date" },
        display: {
          list: true,
          detail: true,
          format: "plainDate",
        },
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      {
        key: "plantName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "sourceProductName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "locationName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "taskName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        // Derived on read from the plant's crop guide, for the household's
        // microclimate — formatted month range (e.g. "Feb–Apr") or null.
        key: "guideSowWindow",
        kind: "text",
        nullable: true,
        label: "Guide sow window",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "plant", relation: "plant" }],
        },
        explanation: {
          ruleId: "planting.guide-sow-window",
          description:
            "The sowing window comes from this planting's plant's crop guide adjusted to the household microclimate.",
          readPath: "guideSowWindow",
          sourceDependencies: [{ path: "plantId", label: "Plant" }],
        },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        key: "guideTransplantWindow",
        kind: "text",
        nullable: true,
        label: "Guide transplant window",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "plant", relation: "plant" }],
        },
        explanation: {
          ruleId: "planting.guide-transplant-window",
          description:
            "The transplanting window comes from this planting's plant's crop guide adjusted to the household microclimate.",
          readPath: "guideTransplantWindow",
          sourceDependencies: [{ path: "plantId", label: "Plant" }],
        },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        // Expected first-harvest range: transplantedOn + the transplant range,
        // else sowedOn + the sow range; Plant packet days win over crop-level
        // `garden-practice.ts` estimates. Null without a real date or data.
        key: "expectedHarvestStart",
        kind: "date",
        nullable: true,
        label: "Expected harvest from",
        display: { list: true, format: "plainDate" },
        provenance: {
          kind: "derived",
          sources: [{ entity: "plant", relation: "plant" }],
        },
        explanation: {
          ruleId: "planting.expected-harvest",
          description:
            "The transplant or sow date plus the plant's days to maturity, from its packet when recorded, else the crop estimate.",
          readPath: "expectedHarvestStart",
          sourceDependencies: [
            { path: "sowedOn", label: "Sowed" },
            { path: "transplantedOn", label: "Transplanted" },
            { path: "plantId", label: "Plant" },
          ],
        },
        validation: { read: plainDate.nullable(), create: null, update: null },
      },
      {
        key: "expectedHarvestEnd",
        kind: "date",
        nullable: true,
        label: "Expected harvest until",
        validation: { read: plainDate.nullable(), create: null, update: null },
      },
      {
        // e.g. "Jul 14–24 (crop estimate)"; the basis says whether the days
        // came from the cultivar packet, a cited crop source, or an estimate.
        key: "expectedHarvest",
        kind: "text",
        nullable: true,
        label: "Expected harvest",
        display: { detail: true },
        provenance: {
          kind: "derived",
          sources: [{ entity: "plant", relation: "plant" }],
        },
        explanation: {
          ruleId: "planting.expected-harvest-summary",
          description:
            "The expected harvest range with the source of its days to maturity.",
          readPath: "expectedHarvest",
          sourceDependencies: [{ path: "plantId", label: "Plant" }],
        },
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        // `"<plant display name>"`, else "Unknown plant" — the non-null title.
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
      { key: "plantId", reference: "plant" },
      "outcome",
      { key: "sourceProductId", reference: "product" },
      { key: "locationId", reference: "location" },
      { key: "taskId", reference: "task" },
      {
        key: "status",
        specialized: "enum:status",
        default: "literal",
        defaultValue: "planned",
      },
      "quantity",
      "notes",
      "plannedWindow",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "plantId",
      "sourceProductId",
      "locationId",
      "taskId",
      "status",
      "outcome",
      "quantity",
      "notes",
      "plannedWindow",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
    ],
    update: [
      "plantId",
      "sourceProductId",
      "locationId",
      "taskId",
      "status",
      "outcome",
      "quantity",
      "notes",
      "plannedWindow",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
    ],
    bulk: ["status", "outcome", "finishedOn", "locationId"],
    audit: [
      "status",
      "outcome",
      "plantId",
      "locationId",
      "finishedOn",
      "taskId",
    ],
    sort: {
      fields: ["createdAt", "updatedAt", "status", "sowedOn", "finishedOn"],
      default: "createdAt",
    },
    intents: {
      fields: {
        capture: ["plantId", "locationId", "status", "transplantedOn"],
        full: [
          "plantId",
          "sourceProductId",
          "locationId",
          "taskId",
          "status",
          "outcome",
          "quantity",
          "notes",
          "plannedWindow",
          "sowedOn",
          "transplantedOn",
          "finishedOn",
        ],
      },
      create: ["capture", "full"],
      update: ["full"],
    },
    output: [
      "id",
      "plantId",
      "sourceProductId",
      "locationId",
      "taskId",
      "status",
      "outcome",
      "quantity",
      "notes",
      "plannedWindow",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
      "displayName",
      "plantName",
      "expectedHarvestStart",
      "expectedHarvestEnd",
      "expectedHarvest",
      "sourceProductName",
      "locationName",
      "taskName",
      "guideSowWindow",
      "guideTransplantWindow",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: {
      module: "@cubby/schemas/planting",
      export: "plantingCreateInput",
    },
    update: { module: "@cubby/schemas/planting", export: "plantingUpdateData" },
    output: { module: "@cubby/schemas/planting", export: "plantingOut" },
    list: { module: "@cubby/schemas/planting", export: "plantingListItemOut" },
  },
  filters: {
    audit: true,
    schema: {
      module: "@cubby/schemas/planting",
      export: "plantingFilterFields",
    },
    descriptors: [
      {
        columnId: "status",
        kind: "multiselect",
        placeholder: "Filter by status...",
        options: [
          { value: "planned", label: "Planned" },
          { value: "growing", label: "Growing" },
          { value: "finished", label: "Finished" },
        ],
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "locationId",
        kind: "idMulti",
        placeholder: "Filter by location...",
        brandRef: { entity: "location" },
      },
      {
        // Virtual, URL-only scope consumed by dependent Garden Entry
        // planting pickers; the repository computes lifecycle membership.
        columnId: "activeOn",
        kind: "text",
        placeholder: "Filter plantings active on...",
        urlOnly: true,
      },
      {
        columnId: "plantId",
        kind: "idMulti",
        placeholder: "Filter by plant...",
        brandRef: { entity: "plant" },
      },
      {
        columnId: "taskId",
        kind: "idMulti",
        placeholder: "Filter by task...",
        brandRef: { entity: "task" },
      },
      {
        columnId: "sourceProductId",
        kind: "idMulti",
        placeholder: "Filter by seed source...",
        brandRef: { entity: "product" },
      },
      {
        // Plantings a garden entry is logged against (`GardenEntryPlanting`).
        columnId: "gardenEntryId",
        kind: "idMulti",
        placeholder: "Filter by garden entry...",
        brandRef: { entity: "gardenEntry" },
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "plant",
      label: "Plant",
      target: "plant",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.plantId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Planting.plantId", direction: "incoming" }],
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
      key: "task",
      label: "Task",
      target: "task",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.taskId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Planting.taskId", direction: "incoming" }],
      },
    },
    {
      key: "entries",
      label: "Journal entries",
      target: "gardenEntry",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "GardenEntryPlanting.plantingId", direction: "incoming" },
          { edge: "GardenEntryPlanting.gardenEntryId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "GardenEntryPlanting.gardenEntryId", direction: "incoming" },
          { edge: "GardenEntryPlanting.plantingId", direction: "outgoing" },
        ],
      },
    },
  ],
  // `displayName` is a non-null projected title (the plant's), so
  // Cmd-K / `/search` can index plantings like every other named entity.
  search: { enabled: true },
  capabilities: {
    auditable: true,
    timeline: "custom",
    images: {
      storage: false,
      displaySources: [
        {
          relationPath: ["entries"],
          priority: 1,
          ordering: "newest",
          identityEvidence: false,
        },
        {
          relationPath: ["source-product"],
          priority: 2,
          ordering: "declared",
          identityEvidence: false,
        },
      ],
      ingress: [
        {
          kind: "existingRelated",
          routeId: "planting-garden-entry",
          relationPath: ["entries"],
          choice: "alternate",
        },
        {
          kind: "createRelated",
          routeId: "planting-new-garden-entry",
          relationPath: ["entries"],
          choice: "primary",
          bindings: [
            { field: "plantingIds", from: "source-id-list" },
            {
              field: "locationId",
              from: "source-field",
              sourceField: "locationId",
            },
            { field: "kind", from: "constant", value: "note" },
            { field: "observedOn", from: "capture-date" },
          ],
        },
        {
          kind: "createSelf",
          routeId: "planting-new",
          enabled: false,
          disabledReason:
            "Plantings have no image storage of their own; attach photos via a garden entry instead",
        },
      ],
      routing: {
        category: "plants",
        candidateFields: ["plantName", "notes"],
        temporalFields: ["sowedOn", "transplantedOn", "finishedOn"],
        lifecycleFilters: [{ field: "status", equals: "growing" }],
        signals: {
          ocrFields: ["plantName", "notes"],
          classifierLabels: ["plant", "garden"],
        },
        visualEvidence: [
          {
            relationPath: ["entries"],
            priority: 1,
            ordering: "newest",
          },
        ],
        abstention: { minimumScore: 0.76, minimumMargin: 0.14 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["status", "outcome", "finishedOn", "locationId"] },
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "create", "update", "delete", "bulkUpdate"],
    dataQuality: {
      checks: [
        {
          id: "planting_location",
          facet: "linkage",
          weight: 1,
          label: "Location",
          message: "No location is recorded for this planting.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/garden/entity-adapters",
        export: "plantingEntityAdapter",
      },
      filters: null,
      timeline: {
        module: "~/server/repo/garden/timeline",
        export: "plantingTimeline",
      },
    },
  },
});

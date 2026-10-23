import { dateRangeSchema, storedDateRangeSchema } from "../date-range";
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
    icons: { phosphor: "Plant", sfSymbol: "leaf", emoji: "🌱" },
    detail: {
      summary: [
        {
          kind: "records",
          id: "plant",
          title: "Plant",
          viewKey: "relation:plant",
        },
        {
          kind: "fields",
          id: "quantity",
          title: "Quantity",
          fields: ["quantity"],
        },
        {
          kind: "fields",
          id: "growing-state",
          title: "Growing state",
          fields: ["status", "season", "transplantedOn"],
        },
        {
          kind: "records",
          id: "location",
          title: "Location",
          viewKey: "relation:location",
        },
        {
          kind: "fields",
          id: "harvest-window",
          title: "Harvest window",
          fields: ["expectedHarvest"],
        },
        {
          kind: "records",
          id: "seed-source",
          title: "Seed source",
          viewKey: "relation:source-product",
        },
        {
          kind: "records",
          id: "task",
          title: "Task",
          viewKey: "relation:task",
        },
        {
          kind: "records",
          id: "observations",
          title: "Observations",
          viewKey: "relation:entries",
        },
      ],

      activityRelations: [{ relation: "entries", dateField: "observedOn" }],
      variantOverride: "journal",
      hero: { chip: "status" },
      sectionOverrides: [
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
            "notes",
            "harvestAmount",
          ],
          sort: { field: "observedOn", direction: "desc" },
        },
        {
          kind: "fields",
          id: "overview",
          title: "Planting details",
          fields: [
            "plantId",
            "status",
            "outcome",
            "locationId",
            "sourceProductId",
            "quantity",
            "plannedWindow",
            "season",
            "transplantedOn",
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
      read: {
        relations: [
          "plantId",
          "sourceProductId",
          "locationId",
          "taskId",
          "plantName",
          "sourceProductName",
          "locationName",
          "taskName",
        ],
        derived: [
          "expectedHarvestStart",
          "expectedHarvestEnd",
          "expectedHarvest",
          "guideSowWindow",
          "guideTransplantWindow",
        ],
        media: ["displayImages"],
        quality: ["dataQuality"],
      },
      views: [
        "table",
        {
          kind: "slot",
          id: "calendar",
          label: "Calendar",
          searchKeys: ["period", "calendarDate"],
        },
        {
          kind: "slot",
          id: "schedule",
          label: "Schedule",
          searchKeys: ["year"],
        },
        "timeline",
      ],
      links: [{ label: "Garden workbench", path: "/garden-workbench" }],
      timeline: {
        fields: [
          "season.start",
          "transplantedOn",
          "expectedHarvestStart",
          "season.end",
        ],
        lifecycle: {
          start: ["season.start", "transplantedOn"],
          milestones: ["transplantedOn", "expectedHarvestStart"],
          end: "season.end",
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
        control: { kind: "specialized", renderer: "entity-select" },
        display: { columnGroup: "Planting" },
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
            {
              value: "succeeded",
              label: "Succeeded",
              color: "positive",
            },
            {
              value: "failed",
              label: "Failed",
              color: "destructive",
            },
          ],
        },
        display: {
          columnGroup: "Planting",
          optionRole: "status",
          optionColor: "neutral-status",
        },
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
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: false },
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
        control: { kind: "specialized", renderer: "entity-select" },
        display: {
          columnGroup: "Planting",
          mobile: { slot: "subtitle", priority: 10 },
        },
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
        control: { kind: "specialized", renderer: "entity-select" },
        display: { list: false },
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
          suggest: {
            basis: ["transplantedOn", "season"],
            rules: [
              `Infer the planting lifecycle status from its dates, compared with Today. A finished date on or before Today indicates finished. A sow or transplant date on or before Today indicates growing. A sow or transplant date after Today is an estimate on a planned planting, so choose planned; with no dates choose planned.`,
            ],
          },
          options: [
            {
              value: "planned",
              label: "Planned",
              description:
                "Planned for a future or not-yet-established planting",
              color: "neutral-status",
            },
            {
              value: "growing",
              label: "Growing",
              description: "Currently transplanted or actively growing",
              color: "positive",
            },
            {
              value: "finished",
              label: "Finished",
              description: "No longer growing or completed",
              color: "neutral-status",
            },
          ],
        },
        display: {
          columnGroup: "Planting",
          mobile: { slot: "trailing", priority: 10 },
          optionRole: "status",
          optionColor: "neutral-status",
        },
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
        display: { list: false },
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
        display: { list: false },
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
        control: { kind: "text" },
        display: { list: false },
        validation: {
          read: optionalText,
          create: optionalText.default(null),
          update: optionalText.optional(),
        },
      },
      {
        key: "season",
        kind: "dateRange",
        nullable: true,
        dateRange: { start: "sowedOn", end: "finishedOn", semantics: "period" },
        control: { kind: "dateRange" },
        display: { columnGroup: "Schedule", columnIdOverride: "sowedOn" },
        validation: {
          read: storedDateRangeSchema.nullable(),
          create: dateRangeSchema.nullable().default(null),
          update: dateRangeSchema.nullable().optional(),
        },
      },
      { key: "sowedOn", kind: "date", nullable: true },
      {
        key: "transplantedOn",
        kind: "date",
        nullable: true,
        control: { kind: "date" },
        display: {
          columnGroup: "Schedule",
          columnLabel: "Transplanted",
          format: "plainDate",
        },
        validation: {
          read: plainDate.nullable(),
          create: plainDate.nullable().default(null),
          update: plainDate.nullable().optional(),
        },
      },
      { key: "finishedOn", kind: "date", nullable: true },
      {
        display: { detail: false, list: false },
        key: "plantName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "sourceProductName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "locationName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
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
        display: { list: false },
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
        display: { list: false },
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
        // Expected first-harvest range: the later of sowedOn + the sow range and
        // transplantedOn + the transplant range; Plant packet days win over
        // crop-level `garden-practice.ts` estimates. Null without a real date or data.
        key: "expectedHarvestStart",
        kind: "date",
        nullable: true,
        display: {
          columnGroup: "Schedule",
          detail: false,
          columnLabel: "Harvest",
          format: "plainDate",
        },
        provenance: {
          kind: "derived",
          sources: [{ entity: "plant", relation: "plant" }],
        },
        explanation: {
          ruleId: "planting.expected-harvest",
          description:
            "The later of the sow and transplant dates each plus the plant's days to maturity, from its packet when recorded, else the crop estimate.",
          readPath: "expectedHarvestStart",
          sourceDependencies: [
            { path: "season.start", label: "Sowed" },
            { path: "transplantedOn", label: "Transplanted" },
            { path: "plantId", label: "Plant" },
          ],
        },
        validation: { read: plainDate.nullable(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "expectedHarvestEnd",
        kind: "date",
        nullable: true,
        validation: { read: plainDate.nullable(), create: null, update: null },
      },
      {
        // e.g. "Jul 14–24 (crop estimate)"; the basis says whether the days
        // came from the cultivar packet, a cited crop source, or an estimate.
        key: "expectedHarvest",
        kind: "text",
        nullable: true,
        display: { list: false },
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
        display: { detail: false, list: false },
        // `"<plant display name>"`, else "Unknown plant" — the non-null title.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        display: { detail: false, list: false },
        key: "id",
        kind: "identifier",
        validation: { read: plantingShortcode, create: null, update: null },
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
        defaultValue: "planned",
      },
      "quantity",
      "notes",
      "plannedWindow",
      "sowedOn",
      "transplantedOn",
      "finishedOn",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
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
      "season",
      "transplantedOn",
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
      "season",
      "transplantedOn",
    ],
    audit: ["status", "outcome", "plantId", "locationId", "taskId"],
    derived: {
      gardenEntryId: { via: "entries" },
      // From the first of sowed, transplanted or created to `finishedOn`
      // (open while unfinished).
      activeSpan: { type: "dateInterval" },
    },
    sort: {
      fields: ["createdAt", "updatedAt", "status", "sowedOn", "finishedOn"],
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
          "season",
          "transplantedOn",
        ],
      },
      create: ["full", "capture"],
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
      "season",
      "transplantedOn",
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
  storage: {
    indexes: [{ on: ["status"] }],
    relations: {
      plant: "plantId",
      sourceProduct: "sourceProductId",
      location: "locationId",
      task: "taskId",
    },
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
        deriveSchema: true,
        stored: true,
        placeholder: "Filter by location...",
        brandRef: { entity: "location" },
      },
      {
        // Also consumed by dependent Garden Entry planting pickers:
        // plantings whose active span contains the day.
        columnId: "activeOn",
        kind: "range",
        wire: { kind: "param", name: "activeOn" },
        derived: "activeSpan",
        placeholder: "Filter plantings active on...",
      },
      {
        // Plantings whose active span overlaps the window ("active this
        // season").
        columnId: "activeSpan",
        kind: "range",
        wire: { kind: "range", from: "activeFrom", to: "activeTo" },
        derived: true,
        placeholder: "Filter plantings active between...",
      },
      {
        columnId: "plantId",
        kind: "idMulti",
        placeholder: "Filter by plant...",
        brandRef: { entity: "plant" },
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "taskId",
        kind: "idMulti",
        placeholder: "Filter by task...",
        brandRef: { entity: "task" },
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "sourceProductId",
        kind: "idMulti",
        placeholder: "Filter by seed source...",
        brandRef: { entity: "product" },
        deriveSchema: true,
        stored: true,
      },
      {
        // Plantings a garden entry is logged against (`gardenEntryPlanting`).
        columnId: "gardenEntryId",
        kind: "idMulti",
        placeholder: "Filter by garden entry...",
        brandRef: { entity: "gardenEntry" },
        deriveSchema: true,
        derived: true,
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
          { edge: "EntityLink[gardenEntryPlanting].to", direction: "incoming" },
          {
            edge: "EntityLink[gardenEntryPlanting].from",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "EntityLink[gardenEntryPlanting].from",
            direction: "incoming",
          },
          { edge: "EntityLink[gardenEntryPlanting].to", direction: "outgoing" },
        ],
      },
    },
  ],
  // `displayName` is a non-null projected title (the plant's), so
  // Cmd-K / `/search` can index plantings like every other named entity.
  search: "semantic",
  capabilities: {
    timeline: "custom",
    images: {
      storage: false,
      displaySourceOverrides: [
        {
          relationPath: ["entries"],
          ordering: "newest",
        },
        {
          relationPath: ["source-product"],
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
        temporalFields: ["season.start", "transplantedOn", "season.end"],
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
    delete: { mode: "soft", bulk: true },
    merge: false,
    dataQuality: {
      checks: [
        {
          id: "planting_location",
          satisfiedLabel: "Location recorded",
          placement: { field: "locationId" },
          facet: "linkage",
          weight: 2,
          label: "Location",
          message: "No location is recorded for this planting.",
        },
        {
          id: "planting_started",
          satisfiedLabel: "Start recorded",
          placement: { field: "status" },
          facet: "content",
          weight: 1,
          label: "Start date",
          message:
            "No sow or transplant date is recorded for a started planting.",
        },
        {
          id: "planting_finished",
          satisfiedLabel: "Finish recorded",
          placement: { field: "season" },
          facet: "content",
          weight: 2,
          label: "Finish",
          message: "This finished planting has no finish date or outcome.",
        },
        {
          id: "planting_lifecycle",
          satisfiedLabel: "Lifecycle consistent",
          placement: { field: "status" },
          facet: "integrity",
          kind: "defect",
          weight: 2,
          scoreCap: 49,
          label: "Lifecycle",
          message: "Status, outcome, or dates contradict each other.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/domains/garden/repo/repository",
        export: "plantingRepository",
      },
      filters: null,
      timeline: {
        module: "~/server/domains/garden/repo/timeline",
        export: "plantingTimeline",
      },
    },
  },
});

import { defineEntity } from "./definition.js";
import { ingredientShortcode, plantShortcode } from "../identifier-fields.js";
import { plantBreeding, plantVerdict } from "@cubby/schemas/garden-fields";
import {
  gardenCropKey,
  gardenCropKeys,
  gardenCropLabel,
} from "@cubby/schemas/garden-practice";
import { z } from "zod";

const optionalText = z.string().trim().min(1).nullable();
const optionalDays = z.number().int().positive().nullable();
const daysField = <const K extends string>(key: K, _label: string) =>
  ({
    key,
    kind: "number",
    nullable: true,

    control: { kind: "number" },
    display: { detail: true },
    validation: {
      read: optionalDays,
      create: optionalDays.default(null),
      update: optionalDays.optional(),
    },
  }) as const;
const derivedText = <const K extends string>(
  key: K,
  _label: string,
  description: string,
) => ({
  key,
  kind: "text" as const,
  nullable: true as const,

  display: { detail: true as const },
  provenance: {
    kind: "derived" as const,
    sources: [
      { label: "Garden guide, garden practice and household microclimate" },
    ],
  },
  explanation: {
    ruleId: `plant.${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`,
    description,
    readPath: key,
    sourceDependencies: [{ path: "gardenGuideKey" as const, label: "Crop" }],
  },
  validation: { read: z.string().nullable(), create: null, update: null },
});

export default defineEntity({
  key: "plant",
  names: { singular: "Plant", plural: "Plants" },
  route: { basePath: "plants" },
  table: "Plant",
  identifiers: { brand: "PlantId", shortcode: "PLANT-" },
  presentation: {
    titleField: "displayName",
    domain: "house",
    description:
      "Cultivars and species the household sows or buys as transplants, with verdicts.",
    emptyState: {
      title: "No plants yet",
      description:
        "Plants appear here as cultivars are planted, bought, or judged worth growing.",
      actionLabel: "New Plant",
    },
    icons: { phosphor: "Leaf", sfSymbol: "leaf.circle", emoji: "🌿" },
    detail: {},
    list: {
      links: [{ label: "Garden workbench", path: "/garden-workbench" }],
    },
  },
  model: {
    fields: [
      {
        key: "name",
        kind: "text",
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          read: z.string(),
          create: z.string().trim().min(1, "Plant name is required"),
          update: z.string().trim().min(1, "Plant name is required").optional(),
        },
      },
      {
        key: "gardenGuideKey",
        kind: "text",
        nullable: true,
        control: {
          kind: "select",
          options: gardenCropKeys.map((key) => ({
            value: key,
            label: gardenCropLabel(key),
          })),
        },
        display: { list: true, detail: true },
        validation: {
          read: gardenCropKey.nullable(),
          create: gardenCropKey.nullable().default(null),
          update: gardenCropKey.nullable().optional(),
        },
      },
      {
        key: "verdict",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: [
            { value: "yes", label: "Yes" },
            { value: "maybe", label: "Maybe" },
            { value: "no", label: "No" },
          ],
        },
        display: { list: true, detail: true },
        validation: {
          read: plantVerdict.nullable(),
          create: plantVerdict.nullable().default(null),
          update: plantVerdict.nullable().optional(),
        },
      },
      {
        key: "ingredientId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "ingredient" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: ingredientShortcode.nullable(),
          create: ingredientShortcode.nullable().default(null),
          update: ingredientShortcode.nullable().optional(),
        },
      },
      {
        key: "latinName",
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
        key: "breeding",
        kind: "enum",
        nullable: true,
        control: {
          kind: "select",
          options: [
            { value: "open-pollinated", label: "Open-pollinated" },
            { value: "hybrid", label: "Hybrid" },
          ],
        },
        display: { detail: true },
        validation: {
          read: plantBreeding.nullable(),
          create: plantBreeding.nullable().default(null),
          update: plantBreeding.nullable().optional(),
        },
      },
      // Cultivar days to first harvest, from the packet or vendor listing only;
      // crop-level estimates live in `garden-practice.ts`.
      daysField("daysFromSowMin", "Days from sowing (min)"),
      daysField("daysFromSowMax", "Days from sowing (max)"),
      daysField("daysFromTransplantMin", "Days from transplant (min)"),
      daysField("daysFromTransplantMax", "Days from transplant (max)"),
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
        key: "ingredientName",
        kind: "text",
        nullable: true,
        validation: { read: z.string().nullable(), create: null, update: null },
      },
      derivedText(
        "guideSowWindow",
        "Guide sow window",
        "The sowing window comes from this plant's crop guide adjusted to the household microclimate.",
      ),
      derivedText(
        "guideTransplantWindow",
        "Guide transplant window",
        "The transplanting window comes from this plant's crop guide adjusted to the household microclimate.",
      ),
      derivedText(
        "routes",
        "Start routes",
        "Each way the household starts this crop, read against this month's guide windows.",
      ),
      {
        // `"<name> · <crop label>"`, or `name` alone without a crop or when the
        // name already is the crop label.
        key: "displayName",
        kind: "text",
        validation: { read: z.string(), create: null, update: null },
      },
      {
        key: "id",
        kind: "identifier",
        validation: { read: plantShortcode, create: null, update: null },
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
        specialized: "primary-key:PlantId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      "gardenGuideKey",
      "verdict",
      { key: "ingredientId", reference: "ingredient" },
      "latinName",
      "breeding",
      "daysFromSowMin",
      "daysFromSowMax",
      "daysFromTransplantMin",
      "daysFromTransplantMax",
      "notes",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
    ],
    create: [
      "name",
      "gardenGuideKey",
      "verdict",
      "ingredientId",
      "latinName",
      "breeding",
      "daysFromSowMin",
      "daysFromSowMax",
      "daysFromTransplantMin",
      "daysFromTransplantMax",
      "notes",
    ],
    update: [
      "name",
      "gardenGuideKey",
      "verdict",
      "ingredientId",
      "latinName",
      "breeding",
      "daysFromSowMin",
      "daysFromSowMax",
      "daysFromTransplantMin",
      "daysFromTransplantMax",
      "notes",
    ],
    bulk: ["verdict", "gardenGuideKey"],
    audit: ["name", "gardenGuideKey", "verdict", "ingredientId", "notes"],
    sort: {
      fields: ["name", "createdAt", "updatedAt"],
    },
    intents: {
      fields: {
        capture: ["name", "gardenGuideKey"],
        full: [
          "name",
          "gardenGuideKey",
          "verdict",
          "ingredientId",
          "latinName",
          "breeding",
          "daysFromSowMin",
          "daysFromSowMax",
          "daysFromTransplantMin",
          "daysFromTransplantMax",
          "notes",
        ],
      },
      create: ["capture", "full"],
      update: ["full"],
    },
    output: [
      "id",
      "name",
      "gardenGuideKey",
      "verdict",
      "ingredientId",
      "latinName",
      "breeding",
      "daysFromSowMin",
      "daysFromSowMax",
      "daysFromTransplantMin",
      "daysFromTransplantMax",
      "notes",
      "displayName",
      "ingredientName",
      "guideSowWindow",
      "guideTransplantWindow",
      "routes",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/plant", export: "plantCreateInput" },
    update: { module: "@cubby/schemas/plant", export: "plantUpdateData" },
    output: { module: "@cubby/schemas/plant", export: "plantOut" },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/plant", export: "plantFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "search",
        urlKey: "q",
        kind: "text",
        placeholder: "Search plants...",
        deriveSchema: true,
        stored: true,
      },
      {
        columnId: "gardenGuideKey",
        kind: "multiselect",
        placeholder: "Filter by crop...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/garden-practice",
          export: "gardenCropKey",
        },
        options: gardenCropKeys.map((key) => ({
          value: key,
          label: gardenCropLabel(key),
        })),
      },
      {
        columnId: "verdict",
        kind: "multiselect",
        placeholder: "Filter by verdict...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/garden-fields",
          export: "plantVerdict",
        },
        options: [
          { value: "yes", label: "Yes" },
          { value: "maybe", label: "Maybe" },
          { value: "no", label: "No" },
        ],
      },
      {
        columnId: "ingredientId",
        kind: "idMulti",
        placeholder: "Filter by ingredient...",
        brandRef: { entity: "ingredient" },
      },
    ],
  },
  relations: [
    {
      key: "ingredient",
      label: "Ingredient",
      target: "ingredient",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Plant.ingredientId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Plant.ingredientId", direction: "incoming" }],
      },
    },
    {
      key: "plantings",
      label: "Plantings",
      target: "planting",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Planting.plantId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Planting.plantId", direction: "outgoing" }],
      },
    },
    {
      key: "products",
      label: "Seeds and plants",
      target: "product",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Product.growsPlantId", direction: "incoming" }],
      },
      inverse: {
        steps: [{ edge: "Product.growsPlantId", direction: "outgoing" }],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: false,
      displaySourceOverrides: [
        {
          relationPath: ["products"],
          priority: 1,
          ordering: "declared",
          identityEvidence: false,
        },
        {
          relationPath: ["plantings", "entries"],
          priority: 2,
          ordering: "newest",
          identityEvidence: false,
        },
      ],
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: { fields: ["verdict", "gardenGuideKey"] },
    merge: true,
    operationOwners: { delete: "kernel", merge: "kernel" },
    mcp: ["get", "list", "create", "update", "delete", "bulkUpdate", "merge"],
    dataQuality: {
      checks: [
        {
          id: "plant_crop",
          facet: "linkage",
          weight: 1,
          label: "Crop",
          message: "No crop is recorded for this plant.",
        },
      ],
    },
  },
  extensions: {
    ports: {
      repository: {
        module: "~/server/repo/plant.entity-adapter",
        export: "plantEntityAdapter",
      },
    },
  },
});

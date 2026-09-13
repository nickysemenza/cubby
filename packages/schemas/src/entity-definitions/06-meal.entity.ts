import { defineEntity } from "./definition.js";
import { mealShortcode } from "../identifier-fields.js";
import {
  mealKindSchema,
  mealTypeSchema,
} from "@cubby/schemas/meal-classification";
import {
  mealRecipeInput,
  mealRecipeOut,
  mealTotals,
} from "@cubby/schemas/meal-fields";
import { mealDate } from "@cubby/schemas/meal-shared";
import { z } from "zod";
export default defineEntity({
  key: "meal",
  names: { singular: "Meal", plural: "Meals" },
  route: { basePath: "meals" },
  table: "Meal",
  identifiers: { brand: "MealId", shortcode: "MEL-", legacy: null },
  presentation: {
    titleField: "name",
    domain: "plan",
    description: "Dated meal plans and preparation records.",
    emptyState: {
      title: "No meals planned",
      description:
        "Plan recipes onto your calendar to see costs add up and build a shopping list.",
      actionLabel: "Plan a Meal",
    },
    icons: { lucide: "CalendarDays", sfSymbol: "fork.knife.circle" },
  },
  model: {
    fields: [
      {
        key: "date",
        kind: "date",
        control: { kind: "date", section: "schedule" },
        display: { list: true, detail: true },
        validation: {
          read: mealDate,
          create: mealDate,
          update: mealDate.optional(),
        },
      },
      {
        key: "name",
        kind: "text",
        nullable: true,
        control: { kind: "text" },
        display: { list: true, detail: true },
        validation: {
          read: z.string().nullable(),
          create: z.string().nullable().optional(),
          update: z.string().nullable().optional(),
        },
      },
      {
        key: "sortOrder",
        kind: "number",
        nullable: true,
        control: { kind: "number", section: "ordering" },
        display: { list: true, detail: true },
        validation: {
          read: z.number().int().nullable(),
          create: z.number().int().nullable().optional(),
          update: z.number().int().nullable().optional(),
        },
      },
      {
        key: "mealType",
        kind: "enum",
        nullable: true,
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          read: mealTypeSchema.nullable(),
          create: mealTypeSchema
            .describe(
              "Which eating occasion of the day this is. Null when unslotted; the planning calendar orders a day's meals by it.",
            )
            .nullable()
            .optional(),
          update: mealTypeSchema
            .describe(
              "Which eating occasion of the day this is. Null when unslotted; the planning calendar orders a day's meals by it.",
            )
            .nullable()
            .optional(),
        },
      },
      {
        key: "mealKind",
        kind: "enum",
        control: { kind: "select" },
        display: { list: true, detail: true },
        validation: {
          read: mealKindSchema,
          create: mealKindSchema
            .describe(
              "How the meal is eaten. Defaults to `cooked`. Use `eating_out`/`takeout` for a placeholder meal that intentionally has no recipes; only `cooked` meals feed the shopping list.",
            )
            .optional(),
          update: mealKindSchema
            .describe(
              "How the meal is eaten. Defaults to `cooked`. Use `eating_out`/`takeout` for a placeholder meal that intentionally has no recipes; only `cooked` meals feed the shopping list.",
            )
            .optional(),
        },
      },
      {
        key: "recipes",
        kind: "json",
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true },
        validation: {
          read: z.array(mealRecipeOut),
          create: z.array(mealRecipeInput).optional(),
          update: null,
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: mealShortcode,
          create: null,
          update: null,
        },
      },
      {
        key: "totals",
        kind: "json",
        display: { detail: true },
        validation: {
          read: mealTotals,
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
      { key: "id", default: "generated", specialized: "primary-key:MealId" },
      { key: "shortcode", specialized: "shortcode" },
      "date",
      "name",
      "sortOrder",
      { key: "mealType", specialized: "enum:mealType" },
      {
        key: "mealKind",
        default: "literal",
        defaultValue: "'cooked'",
        specialized: "enum:mealKind",
      },
      { key: "createdAt", default: "now" },
      { key: "updatedAt", default: "now", specialized: "updated-at" },
      "deletedAt",
    ],
    create: ["date", "name", "sortOrder", "mealType", "mealKind", "recipes"],
    update: ["date", "name", "sortOrder", "mealType", "mealKind"],
    bulk: [],
    audit: [],
    sort: {
      fields: ["date", "name", "mealType", "createdAt", "updatedAt"],
      default: "date",
    },
    intents: {
      fields: {
        capture: ["date", "name", "mealType", "mealKind"],
        full: ["date", "name", "mealType", "mealKind", "sortOrder"],
        calendar: ["date", "name", "mealType", "mealKind"],
      },
      create: ["capture", "full"],
      update: ["full", "calendar"],
    },
    output: [
      "id",
      "date",
      "name",
      "sortOrder",
      "mealType",
      "mealKind",
      "recipes",
      "totals",
      "createdAt",
      "updatedAt",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/meal", export: "mealCreateInput" },
    update: { module: "@cubby/schemas/meal", export: "mealUpdateData" },
    output: { module: "@cubby/schemas/meal", export: "mealOut" },
    mcpOutput: {
      module: "@cubby/schemas/meal",
      export: "mealMcpEntityOut",
    },
    mcpList: {
      module: "@cubby/schemas/meal",
      export: "mealMcpEntityOut",
    },
    mcpDetail: {
      module: "@cubby/schemas/meal",
      export: "mealMcpEntityOut",
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/meal", export: "mealFilterFields" },
    descriptors: [
      {
        columnId: "mealType",
        kind: "multiselect",
        placeholder: "Filter by meal type...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/meal-classification",
          export: "mealTypeSchema",
        },
        options: [
          { value: "breakfast", label: "Breakfast" },
          { value: "brunch", label: "Brunch" },
          { value: "lunch", label: "Lunch" },
          { value: "snack", label: "Snack" },
          { value: "dinner", label: "Dinner" },
          { value: "dessert", label: "Dessert" },
        ],
        nullable: { field: "mealTypePresenceFilter", label: "meal type" },
      },
      {
        columnId: "mealKind",
        kind: "multiselect",
        placeholder: "Filter by kind...",
        deriveSchema: true,
        stored: true,
        schemaRef: {
          module: "@cubby/schemas/meal-classification",
          export: "mealKindSchema",
        },
        options: [
          { value: "cooked", label: "Cooked", color: "var(--slate)" },
          { value: "leftovers", label: "Leftovers", color: "var(--slate)" },
          { value: "eating_out", label: "Eating out", color: "var(--primary)" },
          {
            value: "takeout",
            label: "Takeout / delivery",
            color: "var(--primary)",
          },
          { value: "other", label: "Other", color: "var(--slate)" },
        ],
      },
      {
        columnId: "recipeCostCoverage",
        field: "recipeCostCoverage",
        kind: "select",
        placeholder: "Filter recipe cost coverage...",
        options: [{ value: "understated", label: "Understated" }],
      },
      {
        columnId: "related:meal.recipes",
        field: "recipePresenceFilter",
        urlKey: "related-recipe",
        kind: "presence",
        placeholder: "Filter recipes...",
        options: [
          { value: "has", label: "Has recipes", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "recipeId",
        kind: "idMulti",
        placeholder: "Filter by related recipe id...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "recipes",
      label: "Recipes",
      target: "recipe",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealRecipe.mealId", direction: "incoming" },
          { edge: "MealRecipe.recipeId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealRecipe.recipeId", direction: "incoming" },
          { edge: "MealRecipe.mealId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: false,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/meal/entity-adapter",
        export: "mealEntityAdapter",
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

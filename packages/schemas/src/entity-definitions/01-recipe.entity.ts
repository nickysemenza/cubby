import { recipeChildren } from "../child-tables/recipe.js";
import { defineEntity } from "./definition.js";
import {
  cookbookShortcode,
  imageShortcode,
  recipeShortcode,
} from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import { labelField } from "./label-field.js";
import { recipeSectionsInput, recipeSectionsOut } from "../recipe-fields.js";
import {
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeSourceValues,
  recipeTags,
  recipeTopLevelFields,
  recipeTotals,
  recipeYieldSchema,
} from "@cubby/schemas/recipe-shared";
import { FILTER_NONE } from "../filter-sentinel-fields.js";
import { z } from "zod";
export default defineEntity({
  key: "recipe",
  names: { singular: "Recipe", plural: "Recipes" },
  route: {
    listColumns: {
      module: "~/entity/list-columns/recipe",
      export: "recipeListOverride",
    },
    basePath: "recipes",
    createOverride: "page",
    detailOverride: null,
  },
  table: "Recipe",
  children: recipeChildren,
  identifiers: { brand: "RecipeId", shortcode: "RCP-" },
  presentation: {
    titleField: "name",
    domain: "cook",
    description: "Recipes, their sections, and composition.",
    emptyState: {
      title: "Your recipe book awaits",
      description:
        "Start a collection of recipes you love. Import one from a URL, or write it from scratch.",
      actionLabel: "Create Recipe",
    },
    icons: { phosphor: "ChefHat", sfSymbol: "fork.knife", emoji: "🍳" },
    detail: {
      hero: {},
      additionalSectionOverrides: [
        {
          kind: "fields",
          id: "contents",
          title: "Recipe",
          fields: ["sections", "totals"],
        },
        { kind: "slot", id: "workflow", placement: "full" },
      ],
    },
    list: {
      savedViews: [
        {
          id: "no-instructions",
          label: "No instructions",
          description: "Recipes with no written instructions",
          // The source exclusion is spelled as a POSITIVE list plus the `(none)`
          // sentinel, not as a negation: `sourceType` is nullable, a NULL is a
          // legacy hand-entered recipe that must stay visible, and `!= 'Book'`
          // would evaluate UNKNOWN against it and drop it. Book and Notion recipes
          // live elsewhere by design — the text isn't supposed to be here.
          //
          // `recipe-source-complement.unit.test.ts` pins the list to the full
          // enum minus those two, so adding a fifth source can't silently exclude
          // it from this worklist.
          filters: [
            { id: "instructions", value: "none" },
            { id: "sourceType", value: ["Website", "Other", FILTER_NONE] },
          ],
          sort: [{ id: "name", desc: false }],
          layout: {
            columnVisibility: { sourceType: true },
          },
        },
      ],
      read: {
        relations: ["forkedFromRecipeId", "forkedFromRecipeName", "meals"],
        derived: [
          "fieldResolutions",
          "totals",
          "costTotalLabel",
          "caloriesTotalLabel",
          "totalMinutesLabel",
          "cost",
          "calories",
          "protein",
          "carbs",
          "fat",
          "sectionCount",
        ],
        media: ["displayImages"],
        quality: ["dataQuality"],
      },
      links: [
        { label: "Compare", path: "/recipes/compare" },
        { label: "Import", path: "/recipes/import" },
      ],
    },
  },
  model: {
    fields: [
      {
        key: "fieldResolutions",
        kind: "json",
        validation: {
          read: recipeTopLevelFields.fieldResolutions,
          create: null,
          update: null,
        },
      },
      {
        key: "name",
        kind: "text",
        control: { kind: "text", sectionOverride: "identity" },
        display: { list: true, detail: true, standard: "name" },
        validation: {
          read: recipeTopLevelFields.name,
          create: z.string().trim().min(1, "Recipe name is required"),
          update: z
            .string()
            .trim()
            .min(1, "Recipe name is required")
            .optional(),
        },
      },
      {
        key: "meta",
        kind: "json",
        labelOverride: "Source URL",
        nullable: true,
        control: { kind: "specialized", renderer: "structured-field" },
        // The detail row is the source URL: read from the structured value, drawn as a link.
        display: {
          detail: true,
          readPath: "meta.url",
          format: "external-link",
        },
        validation: {
          read: recipeTopLevelFields.meta,
          create: recipeMeta,
          update: recipeMeta.optional(),
        },
      },
      {
        key: "yield",
        kind: "json",
        nullable: true,
        control: { kind: "specialized", renderer: "structured-field" },
        display: { detail: true, format: "amount" },
        validation: {
          read: recipeTopLevelFields.yield,
          create: recipeYieldSchema.nullable().optional(),
          update: recipeYieldSchema.nullable().optional(),
        },
      },
      {
        key: "servings",
        kind: "number",
        nullable: true,
        control: { kind: "number", sectionOverride: "servings" },
        display: {
          list: true,
          detail: true,
          width: "xs",
          mobile: { slot: "trailing", priority: 5, interactive: true },
        },
        resolution: { reset: { servings: null }, redundancy: "eligible" },
        explanation: {
          ruleId: "recipe.effective-servings",
          description:
            "An explicit serving count wins; otherwise a recipe yield measured in servings supplies the count. Clearing servings resumes the live yield fallback.",
          resolver: "field",
          projections: {
            list: "fieldResolutions.servings.value",
            detail: "fieldResolutions.servings.value",
            summary: "fieldResolutions.servings.value",
          },
          sourceDependencies: [
            {
              path: "fieldResolutions.servings.storedValue",
              label: "Stored servings",
            },
            {
              path: "fieldResolutions.servings.fallbackValue",
              label: "Serving yield",
            },
            { path: "yield", label: "Recipe yield" },
          ],
          actions: ["editSource"],
        },
        validation: {
          read: recipeTopLevelFields.servings,
          create: recipeServings.nullable().optional(),
          update: recipeServings.nullable().optional(),
        },
      },
      {
        key: "tags",
        kind: "text-array",
        nullable: true,
        control: { kind: "specialized", renderer: "tag-list" },
        display: { list: true, detail: true },
        validation: {
          read: recipeTopLevelFields.tags,
          create: recipeTags.nullable().optional(),
          update: recipeTags.nullable().optional(),
        },
      },
      {
        key: "notes",
        kind: "text",
        nullable: true,
        description: "Optional. Supports Markdown.",
        control: { kind: "textarea" },
        // Hidden by default (`listHidden`) but toggleable via the View menu —
        // never actually shown by default before this field went through
        // `createEntityDisplayColumns`.
        display: { list: true, detail: true, listHidden: true },
        validation: {
          read: recipeTopLevelFields.notes,
          create: recipeNotes.nullable().optional(),
          update: recipeNotes.nullable().optional(),
        },
      },
      {
        key: "costTotal",
        kind: "number",
        nullable: true,
        // Computed from `totals.cost` at read time — no column of its own
        // in the list row, so a named renderer builds the cell.
        display: {
          list: true,
          labelPath: "costTotalLabel",
          renderer: { list: "estimate-cost" },
        },
        provenance: { kind: "derived", sources: [{ entity: "recipe" }] },
        explanation: {
          ruleId: "recipe.cost-total",
          description:
            "Recipe cost is the stored costing result for the current recipe inputs, including its range and coverage state.",
          resolver: "recipeTotals",
          projections: {
            list: "totals.cost",
            summary: "totals.cost",
          },
          sourceDependencies: [
            { path: "totals.cost", label: "Computed cost result" },
          ],
        },
      },
      {
        key: "caloriesTotal",
        kind: "number",
        nullable: true,
        // Computed from `totals.nutrition.kcal` at read time; see costTotal.
        display: {
          list: true,
          labelPath: "caloriesTotalLabel",
          renderer: { list: "estimate-kcal" },
        },
        provenance: { kind: "derived", sources: [{ entity: "recipe" }] },
        explanation: {
          ruleId: "recipe.calories-total",
          description:
            "Recipe calories are the stored nutrition result for the current recipe inputs, including its range and coverage state.",
          resolver: "recipeTotals",
          projections: {
            list: "totals.nutrition.kcal",
            summary: "totals.nutrition.kcal",
          },
          sourceDependencies: [
            { path: "totals.nutrition.kcal", label: "Computed calorie result" },
          ],
        },
      },
      {
        key: "meals",
        kind: "number",
        // A live MealRecipe count in the list response, not a stored column.
        reference: { entity: "meal", multiple: true },
        display: {
          list: true,
          width: "xs",
          format: "count",
          mobile: { slot: "meta", priority: 40 },
        },
        validation: {
          read: z.number().int(),
          create: null,
          update: null,
        },
        explanation: {
          ruleId: "recipe.meal-count",
          description:
            "Meal count is the number of live meal-recipe links that currently include this recipe.",
          readPath: "meals",
        },
      },
      {
        key: "sections",
        kind: "json",
        labelOverride: "Composition",
        control: { kind: "specialized", renderer: "structured-field" },
        // The body renders in the workflow slot; this row is the composition summary.
        display: { detail: true, detailLabelPath: "compositionLabel" },
        provenance: {
          kind: "relation",
          sources: [{ label: "Recipe sections" }],
        },
        explanation: {
          ruleId: "recipe.sections",
          description:
            "Recipe contents are the current live sections and ingredient lines in their recorded order.",
          readPath: "sections",
          sourceDependencies: [
            { path: "sections", label: "Recipe sections and ingredient lines" },
          ],
        },
        validation: {
          read: recipeSectionsOut,
          create: recipeSectionsInput,
          update: recipeSectionsInput.optional(),
        },
      },
      {
        key: "pendingImageIds",
        kind: "identifier",
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
        control: { kind: "specialized", renderer: "image-order" },
        provenance: {
          kind: "relation",
          sources: [{ entity: "image", relation: "images" }],
        },
        validation: {
          read: null,
          create: null,
          update: z.array(imageShortcode).optional(),
        },
      },
      {
        key: "id",
        kind: "identifier",
        validation: {
          read: recipeTopLevelFields.id,
          create: null,
          update: null,
        },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: recipeTopLevelFields.createdAt,
          create: null,
          update: null,
        },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        display: { detail: true },
        validation: {
          read: recipeTopLevelFields.updatedAt,
          create: null,
          update: null,
        },
      },
      {
        key: "source",
        // Object-valued (a discriminated union of book/website/other
        // sources) — not a text field. The list column always renders
        // through recipelist.tsx's override (cookbook link or external URL).
        kind: "json",
        nullable: true,
        display: {
          list: true,
          detail: true,
          renderer: { list: "recipe-source", detail: "recipe-source" },
        },
        provenance: { kind: "derived", sources: [{ label: "Recipe source" }] },
        explanation: {
          ruleId: "recipe.source",
          description:
            "The source display is normalized from the recipe's cookbook, website, or free-form source record.",
          readPath: "source",
          sourceDependencies: [
            { path: "source", label: "Normalized recipe source" },
          ],
        },
        validation: {
          read: recipeTopLevelFields.source,
          create: null,
          update: null,
        },
      },
      {
        key: "totals",
        kind: "json",
        nullable: true,
        display: { detail: true, detailLabelPath: "totalsLabel" },
        explanation: {
          ruleId: "recipe.totals",
          description:
            "These cost and nutrition totals are the stored costing result exposed for the current recipe inputs.",
          resolver: "recipeTotals",
          readPath: "totals",
          sourceDependencies: [
            { path: "totals", label: "Computed recipe totals" },
          ],
        },
        validation: {
          read: recipeTotals.nullable().optional(),
          create: null,
          update: null,
        },
      },
      // Flat preview projections of `totals` (`totalsPreview`): a partial
      // estimate shows what is known, anything else reads as absent.
      {
        key: "cost",
        labelOverride: "Cost",
        kind: "number",
        nullable: true,
        display: { preview: true, format: "currency" },
        validation: {
          read: z
            .number()
            .nullable()
            .default(null)
            .describe("Known cost of the totals, in dollars"),
          create: null,
          update: null,
        },
      },
      {
        key: "calories",
        labelOverride: "Calories",
        kind: "number",
        nullable: true,
        display: { preview: true },
        validation: {
          read: z
            .number()
            .nullable()
            .default(null)
            .describe("Known kilocalories of the totals"),
          create: null,
          update: null,
        },
      },
      {
        key: "protein",
        labelOverride: "Protein (g)",
        kind: "number",
        nullable: true,
        display: { preview: true },
        validation: {
          read: z
            .number()
            .nullable()
            .default(null)
            .describe("Known grams of protein"),
          create: null,
          update: null,
        },
      },
      {
        key: "carbs",
        labelOverride: "Carbs (g)",
        kind: "number",
        nullable: true,
        display: { preview: true },
        validation: {
          read: z
            .number()
            .nullable()
            .default(null)
            .describe("Known grams of carbohydrate"),
          create: null,
          update: null,
        },
      },
      {
        key: "fat",
        labelOverride: "Fat (g)",
        kind: "number",
        nullable: true,
        display: { preview: true },
        validation: {
          read: z
            .number()
            .nullable()
            .default(null)
            .describe("Known grams of fat"),
          create: null,
          update: null,
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
          ruleId: "recipe.images",
          description:
            "Recipe images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.",
          projections: {
            list: "displayImages",
            detail: "images",
            summary: "displayImages",
          },
          sourceDependencies: [
            { path: "displayImages", label: "Selected recipe images" },
          ],
        },
        validation: {
          read: z.array(imageOut),
          create: null,
          update: null,
        },
      },
      { key: "shortcode", kind: "text" },
      {
        key: "deletedAt",
        kind: "timestamp",
        nullable: true,
      },
      {
        key: "sourceType",
        kind: "enum",
        nullable: true,
        readKeyOverride: "source",
      },
      {
        // A Website recipe's page. A Notion recipe's page id is an
        // EntityExternalId; a cookbook recipe names its Cookbook.
        key: "sourceUrl",
        kind: "text",
        nullable: true,
        readKeyOverride: "source",
      },
      {
        // The book a Book recipe came from when no Cookbook row exists.
        key: "sourceLabel",
        kind: "text",
        nullable: true,
        readKeyOverride: "source",
      },
      {
        // Re-pointing a recipe at another cookbook (or none). Read through
        // `source`, so no read schema of its own.
        key: "cookbookId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "cookbook" },
        validation: {
          read: null,
          create: null,
          update: cookbookShortcode.nullable().optional(),
        },
      },
      {
        key: "forkedFromRecipeId",
        kind: "identifier",
        nullable: true,
        reference: { entity: "recipe" },
        control: { kind: "specialized", renderer: "entity-select" },
        display: { detail: true },
        validation: {
          read: recipeTopLevelFields.forkedFromRecipeId,
          create: recipeShortcode.nullable().optional(),
          update: recipeShortcode.nullable().optional(),
        },
      },
      // Derived, read-only: the forked-from recipe's name, joined at read time
      // (same "<ref>Id" + "<ref>Name" pairing as Task.parentTaskId/parentTaskName)
      // so the UI can render a real link label instead of a bare shortcode.
      {
        key: "forkedFromRecipeName",
        kind: "text",
        nullable: true,
        validation: {
          read: recipeTopLevelFields.forkedFromRecipeName,
          create: null,
          update: null,
        },
      },
      {
        key: "totalsComputedAt",
        kind: "timestamp",
        nullable: true,
      },
      {
        key: "activeMinutes",
        kind: "number",
        nullable: true,
      },
      {
        key: "totalMinutes",
        kind: "number",
        nullable: true,
        // The cell prints the source's own time prose (recipe.meta.times.total)
        // when there is one, which doesn't always imply a present totalMinutes
        // count, so the server composes the text; sorting and the range filter
        // stay on the minute count.
        display: {
          list: true,
          readPath: "meta.times.totalMinutes",
          labelPath: "totalMinutesLabel",
          width: "sm",
          mobile: { slot: "meta", priority: 25 },
        },
        explanation: {
          ruleId: "recipe.total-time",
          description:
            "The time cell shows the recipe source's time text together with its normalized total-minute value when available.",
          projections: { list: "meta.times", summary: "meta.times" },
          sourceDependencies: [
            { path: "meta.times", label: "Recipe time metadata" },
          ],
        },
      },
      // Server-composed text for the computed columns above (`display.labelPath`).
      labelField("costTotalLabel", "Recipe cost total"),
      labelField("caloriesTotalLabel", "Recipe calorie total"),
      labelField("totalMinutesLabel", "Recipe time metadata"),
      // The same, for the structured detail fields (`display.detailLabelPath`).
      labelField("compositionLabel", "Recipe sections"),
      labelField("totalsLabel", "Computed recipe totals"),
    ],
    storage: [
      {
        key: "id",
        specialized: "primary-key:RecipeId",
      },
      { key: "shortcode", specialized: "shortcode" },
      "name",
      { key: "createdAt" },
      { key: "updatedAt", specialized: "updated-at" },
      "deletedAt",
      { key: "sourceType", specialized: "enum:sourceType" },
      "sourceUrl",
      "sourceLabel",
      { key: "cookbookId", reference: "cookbook" },
      { key: "forkedFromRecipeId", reference: "recipe" },
      { key: "yield", specialized: "json:yield" },
      "servings",
      {
        key: "tags",
        nullableOverride: false,
        defaultValue: "'{}'::text[]",
        specialized: "text-array",
      },
      "notes",
      { key: "totals", specialized: "json:totals" },
      "totalsComputedAt",
      "activeMinutes",
      "totalMinutes",
      { key: "meta", specialized: "json:meta" },
    ],
    create: [
      "name",
      "meta",
      "yield",
      "servings",
      "tags",
      "notes",
      "sections",
      "pendingImageIds",
      "forkedFromRecipeId",
    ],
    update: [
      "name",
      "meta",
      "yield",
      "servings",
      "tags",
      "notes",
      "sections",
      "pendingImageIds",
      "removeImageIds",
      "imageOrder",
      "forkedFromRecipeId",
      "cookbookId",
    ],
    bulk: [],
    audit: ["name", "forkedFromRecipeId"],
    sort: {
      fields: [
        "createdAt",
        "updatedAt",
        "name",
        "cookbook",
        "costTotal",
        "caloriesTotal",
        "source",
        "servings",
        "tags",
        "totalMinutes",
      ],
      computed: ["cookbook", "costTotal", "caloriesTotal"],
      groupable: ["name"],
    },
    intents: {
      fields: {
        capture: ["name"],
        full: [
          "name",
          "cookbookId",
          "tags",
          "notes",
          "sections",
          "forkedFromRecipeId",
        ],
        identity: ["name", "cookbookId", "tags"],
      },
      create: ["capture", "full"],
      update: ["full", "identity"],
    },
    output: [
      "id",
      "name",
      "createdAt",
      "updatedAt",
      "meta",
      "source",
      "yield",
      "servings",
      "fieldResolutions",
      "tags",
      "notes",
      "sections",
      "compositionLabel",
      "totals",
      "totalsLabel",
      "cost",
      "calories",
      "protein",
      "carbs",
      "fat",
      "images",
      "forkedFromRecipeId",
      "forkedFromRecipeName",
    ],
  },
  fields: {
    create: { module: "@cubby/schemas/recipe", export: "recipeCreateInput" },
    update: { module: "@cubby/schemas/recipe", export: "recipeUpdateData" },
    output: { module: "@cubby/schemas/recipe", export: "recipeOut" },
    list: { module: "@cubby/schemas/recipe", export: "recipeListItemOut" },
    mcpOutput: {
      module: "@cubby/schemas/recipe",
      export: "recipeMcpEntityOut",
    },
  },
  storage: {
    indexes: [
      // Non-cookbook recipes keep a globally-unique name. Cookbook (Book) and
      // Notion recipes are excluded — they're keyed by (cookbook, name) and by
      // their Notion page's EntityExternalId — so the same title can appear
      // across a cookbook, a Notion page, and a web recipe. `IS DISTINCT FROM`
      // (not NOT IN) keeps NULL-sourceType legacy rows inside the index.
      {
        on: ["name"],
        unique: true,
        where:
          "{deletedAt} IS NULL AND {sourceType} IS DISTINCT FROM 'Book' AND {sourceType} IS DISTINCT FROM 'Notion'",
      },
      // A cookbook recipe's identity is (cookbook, title): unique per book, but
      // the same title may recur across books.
      {
        on: ["cookbookId", "name"],
        unique: true,
        where: "{cookbookId} IS NOT NULL AND {deletedAt} IS NULL",
      },
      { on: ["sourceType"] },
      {
        name: "Recipe_created_at_desc_idx",
        on: [{ column: "createdAt", desc: true }],
      },
      {
        name: "Recipe_name_active_idx",
        on: ["name"],
        where: "{deletedAt} IS NULL",
      },
      {
        name: "Recipe_totals_stale_idx",
        on: ["totalsComputedAt"],
        where: "{totalsComputedAt} IS NULL",
      },
    ],
    checks: [
      {
        column: "sourceType",
        values: [...recipeSourceValues],
        nullClause: true,
        bare: true,
      },
    ],
    relations: {
      sections: { many: "recipeSection" },
      externalIds: {
        many: "entityExternalId",
        relationName: "recipeExternalIds",
      },
      pointerIngredient: {
        one: "ingredient",
        field: "id",
        references: "recipeId",
      },
      cookbook: "cookbookId",
      forkedFrom: {
        field: "forkedFromRecipeId",
        relationName: "RecipeForkedFrom",
      },
      forks: { many: "recipe", relationName: "RecipeForkedFrom" },
      images: { many: "entityAttachment" },
      mealRecipes: { many: "mealRecipe" },
    },
  },
  filters: {
    audit: true,
    schema: { module: "@cubby/schemas/recipe", export: "recipeFilterFields" },
    descriptors: [
      {
        columnId: "name",
        field: "nameFilter",
        kind: "text",
        placeholder: "Filter by recipe name...",
        deriveSchema: true,
        stored: { columns: ["name", "notes"] },
      },
      {
        columnId: "tags",
        field: "tagFilters",
        kind: "multiselect",
        placeholder: "Filter by tag...",
        optionsKey: "tags",
        deriveSchema: true,
        stored: { array: true },
        nullable: { field: "tagsPresenceFilter", label: "tags" },
      },
      {
        columnId: "source",
        field: "cookbookId",
        kind: "idMulti",
        placeholder: "Filter by cookbook...",
        brandRef: { entity: "cookbook" },
        nullable: { field: "cookbookPresenceFilter", label: "cookbook" },
      },
      {
        columnId: "meals",
        field: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter meals...",
        options: [
          { value: "has", label: "Has meals", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
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
        columnId: "instructions",
        field: "instructionsPresenceFilter",
        kind: "presence",
        placeholder: "Filter instructions...",
        options: [
          { value: "has", label: "Has instructions", meta: true },
          { value: "none", label: "(none)", meta: true },
        ],
      },
      {
        columnId: "sourceType",
        field: "sourceTypeFilter",
        kind: "multiselect",
        placeholder: "Filter by source...",
        options: [
          { value: "Book", label: "Book" },
          { value: "Website", label: "Website" },
          { value: "Other", label: "Other" },
          { value: "Notion", label: "Notion" },
        ],
        nullable: { field: "sourceTypePresenceFilter", label: "source" },
      },
      {
        columnId: "costTotal",
        kind: "range",
        placeholder: "Filter recipe cost...",
        options: [
          {
            value: "under10",
            label: "Under $10",
            expand: { costTotalMax: 10 },
          },
          {
            value: "10to25",
            label: "$10–$25",
            expand: { costTotalMin: 10, costTotalMax: 25 },
          },
          {
            value: "25plus",
            label: "$25 and up",
            expand: { costTotalMin: 25 },
          },
        ],
      },
      {
        columnId: "caloriesTotal",
        kind: "range",
        placeholder: "Filter calories...",
        options: [
          {
            value: "under500",
            label: "Under 500 cal",
            expand: { caloriesTotalMax: 500 },
          },
          {
            value: "500to1000",
            label: "500–1,000 cal",
            expand: { caloriesTotalMin: 500, caloriesTotalMax: 1000 },
          },
          {
            value: "1000plus",
            label: "1,000+ cal",
            expand: { caloriesTotalMin: 1000 },
          },
        ],
      },
      {
        columnId: "totalMinutes",
        kind: "range",
        placeholder: "Filter total time...",
        deriveSchema: true,
        stored: true,
        options: [
          {
            value: "under30",
            label: "Under 30 min",
            expand: { totalMinutesMax: 30 },
          },
          {
            value: "30to60",
            label: "30–60 min",
            expand: { totalMinutesMin: 30, totalMinutesMax: 60 },
          },
          {
            value: "60plus",
            label: "Over an hour",
            expand: { totalMinutesMin: 60 },
          },
        ],
      },
      {
        columnId: "related:recipe.ingredients",
        field: "ingredientId",
        urlKey: "related-ingredient",
        kind: "idMulti",
        placeholder: "Filter by ingredient...",
        optionsKey: "recipeIngredients",
        brandRef: { entity: "ingredient" },
        nullable: { field: "ingredientPresenceFilter", label: "ingredient" },
      },
      {
        columnId: "related:recipe.meals",
        field: "mealSearch",
        urlKey: "related-meal",
        kind: "text",
        placeholder: "Search related meals...",
      },
      {
        columnId: "mealId",
        kind: "idMulti",
        placeholder: "Filter by related meals id...",
        brandRef: { entity: "meal" },
        urlOnly: true,
      },
      {
        columnId: "mealPresenceFilter",
        kind: "presence",
        placeholder: "Filter related meals presence...",
        urlOnly: true,
      },
    ],
  },
  relations: [
    {
      key: "cookbook",
      label: "Cookbook",
      target: "cookbook",
      cardinality: "one",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Recipe.cookbookId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Recipe.cookbookId", direction: "incoming" }],
      },
    },
    {
      key: "forkedFrom",
      label: "Forked from",
      target: "recipe",
      cardinality: "one",
      inverseOmit:
        "The recipe page is custom; a recipe's forks are reached from each fork's Forked from field.",
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Recipe.forkedFromRecipeId", direction: "outgoing" }],
      },
      inverse: {
        steps: [{ edge: "Recipe.forkedFromRecipeId", direction: "incoming" }],
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
    {
      key: "ingredients",
      label: "Ingredients",
      target: "ingredient",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "RecipeSection.recipeId", direction: "incoming" },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "outgoing",
          },
        ],
      },
      inverse: {
        steps: [
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "outgoing",
          },
          { edge: "RecipeSection.recipeId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "sub-recipes",
      label: "Sub-recipes",
      target: "recipe",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "RecipeSection.recipeId", direction: "incoming" },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "outgoing",
          },
          { edge: "Ingredient.recipeId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "Ingredient.recipeId", direction: "incoming" },
          {
            edge: "RecipeSectionIngredient.ingredientId",
            direction: "incoming",
          },
          {
            edge: "RecipeSectionIngredient.recipeSectionId",
            direction: "outgoing",
          },
          { edge: "RecipeSection.recipeId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "meals",
      label: "Meals",
      target: "meal",
      cardinality: "many",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealRecipe.recipeId", direction: "incoming" },
          { edge: "MealRecipe.mealId", direction: "outgoing" },
        ],
      },
      inverse: {
        steps: [
          { edge: "MealRecipe.mealId", direction: "incoming" },
          { edge: "MealRecipe.recipeId", direction: "outgoing" },
        ],
      },
      sources: [
        {
          key: "served-portions",
          label: "Served portions",
          provenance: {
            kind: "local-path",
            steps: [
              { edge: "MealRecipe.recipeId", direction: "incoming" },
              {
                edge: "MealRecipePortion.mealRecipeId",
                direction: "incoming",
              },
              { edge: "MealRecipePortion.mealId", direction: "outgoing" },
            ],
          },
          inverse: {
            steps: [
              { edge: "MealRecipePortion.mealId", direction: "incoming" },
              {
                edge: "MealRecipePortion.mealRecipeId",
                direction: "outgoing",
              },
              { edge: "MealRecipe.recipeId", direction: "outgoing" },
            ],
          },
        },
      ],
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: {
      storage: "gallery",
      displaySourceOverrides: [
        {
          relationPath: ["meals"],
          priority: 1,
          ordering: "newest",
          identityEvidence: false,
        },
      ],
      ingress: [
        { kind: "self", routeId: "recipe-self", choice: "primary" },
        {
          kind: "existingRelated",
          routeId: "recipe-meal",
          relationPath: ["meals"],
          choice: "alternate",
        },
        {
          kind: "createRelated",
          routeId: "recipe-new-meal",
          relationPath: ["meals"],
          choice: "alternate",
          bindings: [
            { field: "date", from: "capture-date" },
            {
              field: "recipes",
              from: "relation-items",
              item: { field: "recipeId", from: "source-id" },
            },
          ],
        },
        { kind: "createSelf", routeId: "recipe-new", enabled: true },
      ],
      routing: {
        category: "food",
        candidateFields: ["name"],
        temporalFields: [],
        lifecycleFilters: [],
        signals: { ocrFields: ["name"], classifierLabels: ["food"] },
        visualEvidence: [
          {
            relationPath: ["meals"],
            priority: 1,
            ordering: "newest",
          },
        ],
        abstention: { minimumScore: 0.74, minimumMargin: 0.14 },
      },
    },
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    bulkUpdate: null,
    merge: false,
    operationOwners: { delete: "kernel", merge: null },
    mcp: ["get", "list", "search", "create", "update", "delete"],
    dataQuality: {
      checks: [
        {
          id: "recipe_deleted_dependency",
          facet: "integrity",
          kind: "defect",
          weight: 3,
          scoreCap: 49,
          exceptions: "forbidden",
          label: "Deleted dependency",
          message: "Fresh totals still reference a deleted sub-recipe.",
        },
        {
          id: "recipe_ingredients",
          facet: "content",
          weight: 3,
          scoreCap: 69,
          label: "Ingredients",
          message: "No ingredient line names a live ingredient.",
        },
        {
          id: "recipe_instructions",
          facet: "content",
          weight: 3,
          scoreCap: 69,
          label: "Instructions",
          message: "No written instructions are recorded.",
        },
        {
          id: "recipe_source",
          facet: "provenance",
          weight: 1,
          label: "Source",
          message: "No recipe source is recorded.",
        },
      ],
    },
  },
  extensions: {
    mcpNames: { overrides: { delete: "delete_recipe" } },
    ports: {
      repository: {
        module: "~/server/repo/recipe/repository",
        export: "recipeRepository",
      },
      search: "document",
    },
  },
});

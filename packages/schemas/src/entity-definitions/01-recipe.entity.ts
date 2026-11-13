import { defineEdge } from "./edges";
import { galleryImagesField, galleryWriteFields } from "./image-fields";
import { idField, readOnly, timestampField } from "./field-policy";
import {
  attachedImageInputs,
  imageDescriptionInputs,
} from "./image-description-inputs";
import { recipeReadSchemas } from "../recipe-fields";
import { recipeChildren } from "../child-tables/recipe.js";
import { defineEntity, defineEntityModel } from "./definition.js";
import { cookbookShortcode, recipeShortcode } from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";
import { labelField } from "./label-field.js";
import { recipeSectionsInput, recipeSectionsOut } from "../recipe-fields.js";
import {
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeSourceValues,
  recipeTags,
  rawRecipeTopLevelFields,
  recipeTotals,
  recipeYieldSchema,
} from "@cubby/schemas/recipe-shared";
import { FILTER_NONE } from "../filter-sentinel-fields.js";
import { z } from "zod";
export const { definition, readSchemas } = defineEntityModel(
  {
    key: "recipe",
    edges: [
      defineEdge({
        key: "Recipe.forkedFromRecipeId",
        from: "recipe",
        to: "recipe",
        cardinality: "one",
        inverse: {
          key: "recipe.incoming.Recipe.forkedFromRecipeId",
          from: "recipe",
          to: "recipe",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "Recipe.forkedFromRecipeId",
          constrained: true,
        },
        ownership: {
          kind: "entity",
          entity: "recipe",
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
          role: "hierarchy",
          label: "forks",
          description:
            "A recipe that records this one as the recipe it was forked from — a lineage pointer only, enforced by the Recipe self-FK.",
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
                code: "clear-fork-pointer",
                effect: "detach",
                description:
                  "A deleted recipe's forks have their forkedFromRecipeId pointer nulled out — a fork is a full independent recipe, so it survives its parent's deletion, just without the lineage pointer.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "Ingredient.recipeId",
        from: "ingredient",
        to: "recipe",
        cardinality: "one",
        inverse: {
          key: "recipe.incoming.Ingredient.recipeId",
          from: "recipe",
          to: "ingredient",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "Ingredient.recipeId",
          constrained: true,
        },
        ownership: {
          kind: "entity",
          entity: "ingredient",
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
          role: "reference",
          label: "sub-recipe ingredient lines",
          description:
            "An ingredient line in another recipe's section that uses this recipe as a sub-recipe (composition) rather than a plain ingredient.",
          liveness: {
            kind: "allow-target-deleted",
            reason:
              "Deleting a recipe deliberately preserves the recipe-as-ingredient pointer (`preserve-sub-recipe-pointer` in RECIPE_DELETE_EDGE_POLICY, apps/web/src/server/domains/recipe/repo/crud.ts) so parent recipes still resolve the tombstone for staleness detection and recompute, instead of silently losing a line.",
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
                code: "preserve-sub-recipe-pointer",
                effect: "preserve",
                description:
                  "A deleted recipe's sub-recipe pointer is left untouched — parent recipes are recomputed and re-resolved rather than having this edge cascaded or guarded.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "RecipeSection.recipeId",
        from: "row:RecipeSection",
        to: "recipe",
        cardinality: "one",
        inverse: {
          key: "recipe.incoming.RecipeSection.recipeId",
          from: "recipe",
          to: "row:RecipeSection",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "RecipeSection.recipeId",
          constrained: true,
        },
        ownership: {
          kind: "column",
          column: "RecipeSection.recipeId",
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
          role: "composition",
          label: "recipe sections",
          description:
            'A named section (e.g. "For the crust") that structures this recipe\'s ingredient list; meaningless outside the recipe it belongs to.',
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
                code: "soft-delete-owned-row",
                effect: "soft-delete",
                description:
                  "A recipe's sections, and their ingredient lines, are soft-deleted along with it.",
              },
              handler: null,
              before: {
                module: "~/server/domains/recipe/repo/crud",
                export: "removeRecipeGrandchildren",
              },
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "MealRecipe.recipeId",
        from: "row:MealRecipe",
        to: "recipe",
        cardinality: "one",
        inverse: {
          key: "recipe.incoming.MealRecipe.recipeId",
          from: "recipe",
          to: "row:MealRecipe",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "MealRecipe.recipeId",
          constrained: true,
        },
        ownership: {
          kind: "column",
          column: "MealRecipe.mealId",
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
          role: "association",
          label: "meal-plan entries",
          description:
            "A join row placing this recipe on the meal calendar; the meal and the recipe each exist independently of the pairing.",
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
                  "Meal-plan associations are soft-deleted with the recipe; the meals themselves are not.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "recipe/EntityAttachment.entityId",
        from: "row:EntityAttachment",
        to: "recipe",
        cardinality: "one",
        inverse: {
          key: "recipe.incoming.EntityAttachment.entityId",
          from: "recipe",
          to: "row:EntityAttachment",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "EntityAttachment.entityId",
          constrained: true,
          partition: {
            column: "EntityAttachment.entityKind",
            value: "recipe",
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
          label: "recipe photos",
          description: "A photo attached to this recipe.",
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
                  "Image associations are soft-deleted with the recipe, and each file is\n      deleted too unless something else still references it.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
      defineEdge({
        key: "recipe/EntityExternalId.entityId",
        from: "row:EntityExternalId",
        to: "recipe",
        cardinality: "one",
        inverse: {
          key: "recipe.incoming.EntityExternalId.entityId",
          from: "recipe",
          to: "row:EntityExternalId",
          cardinality: "many",
        },
        storage: {
          kind: "foreign-key",
          column: "EntityExternalId.entityId",
          constrained: true,
          partition: {
            column: "EntityExternalId.entityKind",
            value: "recipe",
          },
        },
        ownership: {
          kind: "identity",
          column: "EntityExternalId.entityId",
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
          role: "metadata",
          label: "external ids",
          description:
            "An identifier another system gives this record (an ASIN, a barcode, a settlement reference, a Notion page); says nothing about ownership or spend.",
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
                code: "soft-delete-metadata",
                effect: "soft-delete",
                description:
                  "Outside identifiers (a Notion page, a Drive folder) are soft-deleted with the record, releasing them to be recorded again.",
              },
              handler: null,
            },
            merge: {
              kind: "unsupported",
              reason: "This operation is not exposed for this endpoint.",
            },
          },
        },
      }),
    ],

    names: { singular: "Recipe", plural: "Recipes" },
    route: {
      listColumns: {
        module: "~/features/recipe/list-columns",
        export: "recipeListOverride",
      },
      basePath: "recipes",
      createOverride: "page",
      detail: null,
    },
    table: "Recipe",
    children: recipeChildren,
    identifiers: { brand: "RecipeId", shortcode: "RCP-" },
    presentation: {
      searchFacts: ["totalMinutes", "servings"],
      edit: {
        sections: [
          {
            id: "identity",
            title: "Identity",
            fields: ["name"],
          },
          { id: "main" },
          {
            id: "servings",
            title: "Servings",
            fields: ["servings"],
          },
        ],
      },
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
        summary: [
          {
            kind: "fields",
            id: "yield-time",
            title: "Yield & time",
            fields: ["servings", "yield", "activeMinutes", "totalMinutes"],
          },
          {
            kind: "report",
            id: "availability",
            title: "Availability",
            slot: "recipe.availability",
          },
          {
            kind: "fields",
            id: "nutrition",
            title: "Nutrition",
            fields: ["calories", "protein", "carbs", "fat"],
          },
          {
            kind: "fields",
            id: "source",
            title: "Source",
            fields: ["source"],
          },
          {
            kind: "report",
            id: "estimated-cost-coverage",
            title: "Estimated cost & coverage",
            slot: "recipe.costing-coverage",
          },
          {
            kind: "records",
            id: "ingredient-products",
            title: "Ingredient Products",
            viewKey: "products",
          },
          {
            kind: "records",
            id: "meals",
            title: "Meals",
            viewKey: "relation:meals",
          },
        ],

        activityRelations: [
          { relation: "images", dateField: "capturedAt" },
          { relation: "meals", dateField: "date" },
        ],

        sections: [
          {
            kind: "fields",
            id: "identity",
            title: "Identity",
            fields: ["name"],
          },
          {
            kind: "fields",
            id: "overview",
            title: "Record",
            fields: ["meta", "yield", "tags", "notes", "forkedFromRecipeId"],
          },
          {
            kind: "fields",
            id: "servings",
            title: "Servings",
            fields: ["servings"],
          },
          {
            kind: "fields",
            id: "coverage",
            title: "Coverage and summaries",
            fields: ["createdAt", "updatedAt", "source", "activeMinutes"],
          },
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
        rail: [{ field: "totalMinutes" }, { field: "servings" }],
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
        links: [
          { label: "Graph", path: "/entities", search: { tab: "recipes" } },
          { label: "Compare", path: "/recipes/compare" },
          { label: "Import", path: "/recipes/import" },
        ],
      },
    },
    model: {
      fields: [
        {
          key: "name",
          kind: "text",
          control: { kind: "text" },
          display: { standard: "name" },
          validation: {
            read: rawRecipeTopLevelFields.name,
            create: z.string().trim().min(1, "Recipe name is required"),
            update: z
              .string()
              .trim()
              .min(1, "Recipe name is required")
              .optional(),
          },
        },
        {
          audit: false,
          key: "meta",
          kind: "json",
          label: "Source URL",
          nullable: true,
          control: { kind: "specialized", renderer: "structured-field" },
          // The detail row is the source URL: read from the structured value, drawn as a link.
          display: {
            list: false,
            readPath: "meta.url",
            format: "external-link",
          },
          validation: {
            read: rawRecipeTopLevelFields.meta,
            create: recipeMeta,
            update: recipeMeta.optional(),
          },
        },
        {
          audit: false,
          key: "yield",
          kind: "json",
          nullable: true,
          control: { kind: "specialized", renderer: "structured-field" },
          display: { list: false, format: "amount" },
          validation: {
            read: rawRecipeTopLevelFields.yield,
            create: recipeYieldSchema.nullable().optional(),
            update: recipeYieldSchema.nullable().optional(),
          },
        },
        {
          audit: false,
          key: "servings",
          kind: "number",
          nullable: true,
          control: { kind: "number" },
          display: {
            columnGroup: "Recipe",
            width: "xs",
            // The list's structured-yield branch is intentionally read-only.
            readFields: ["yield"],
            mobile: { slot: "trailing", priority: 5, interactive: true },
          },
          resolution: { reset: { servings: null }, redundancy: "eligible" },
          explanation: {
            evidence: { kind: "yield" },
            ruleId: "recipe.effective-servings",
            description:
              "An explicit serving count wins; otherwise a recipe yield measured in servings supplies the count. Clearing servings resumes the live yield fallback.",
            resolver: "field",
            projections: {
              list: "servings",
              detail: "servings",
              summary: "servings",
            },
            sourceDependencies: [
              {
                path: "fields.servings.current.assignment.value",
                label: "Stored servings",
              },
              { path: "yield", label: "Recipe yield" },
            ],
          },
          validation: {
            read: rawRecipeTopLevelFields.servings,
            create: recipeServings.nullable().optional(),
            update: recipeServings.nullable().optional(),
          },
        },
        {
          audit: false,
          key: "tags",
          kind: "text-array",
          collection: { key: "value" },
          nullable: true,
          control: { kind: "specialized", renderer: "tag-list" },
          display: { columnGroup: "Recipe" },
          validation: {
            read: rawRecipeTopLevelFields.tags,
            create: recipeTags.nullable().optional(),
            update: recipeTags.nullable().optional(),
          },
        },
        {
          audit: false,
          key: "notes",
          kind: "text",
          nullable: true,
          description: "Optional. Supports Markdown.",
          control: { kind: "textarea" },
          // Hidden by default (`listHidden`) but toggleable via the View menu —
          // never actually shown by default before this field went through
          // `createEntityDisplayColumns`.
          display: { columnGroup: "Recipe", listHidden: true, width: "xl" },
          validation: {
            read: rawRecipeTopLevelFields.notes,
            create: recipeNotes.nullable().optional(),
            update: recipeNotes.nullable().optional(),
          },
        },
        {
          output: false,
          key: "costTotal",
          kind: "number",
          nullable: true,
          // Computed from `totals.cost` at read time — no column of its own
          // in the list row, so a named renderer builds the cell.
          display: {
            columnGroup: "Per recipe",

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
              { path: "storedResult.cost", label: "Published cost result" },
            ],
          },
        },
        {
          output: false,
          key: "caloriesTotal",
          kind: "number",
          nullable: true,
          // Computed from `totals.nutrition.kcal` at read time; see costTotal.
          display: {
            columnGroup: "Per recipe",

            columnLabel: "Calories",
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
              {
                path: "storedResult.nutrition.kcal",
                label: "Published calorie result",
              },
            ],
          },
        },
        {
          output: false,
          key: "meals",
          kind: "number",
          // A live MealRecipe count in the list response, not a stored column.
          reference: { entity: "meal", multiple: true },
          display: {
            columnGroup: "Source & use",
            columnBar: true,
            width: "xs",
            format: "count",
            mobile: { slot: "meta", priority: 40 },
          },
          validation: readOnly(z.number().int()),
          explanation: {
            ruleId: "recipe.meal-count",
            description:
              "Meal count is the number of live meal-recipe links that currently include this recipe.",
            readPath: "meals",
          },
        },
        {
          audit: false,
          key: "sections",
          kind: "json",
          label: "Composition",
          control: { kind: "specialized", renderer: "structured-field" },
          // The body renders in the workflow slot; this row is the composition summary.
          display: { detailLabelPath: "compositionLabel" },
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
              {
                path: "sections",
                label: "Recipe sections and ingredient lines",
              },
            ],
          },
          validation: {
            read: recipeSectionsOut,
            create: recipeSectionsInput,
            update: recipeSectionsInput.optional(),
          },
        },
        ...galleryWriteFields({ pickers: true }),
        idField(rawRecipeTopLevelFields.id),
        timestampField("createdAt"),
        timestampField("updatedAt"),
        {
          key: "source",
          // Object-valued (a discriminated union of book/website/other
          // sources) — not a text field. The list column always renders
          // through recipelist.tsx's override (cookbook link or external URL).
          kind: "json",
          nullable: true,
          display: {
            columnGroup: "Source & use",
            renderer: { list: "recipe-source", detail: "recipe-source" },
          },
          provenance: {
            kind: "derived",
            sources: [{ label: "Recipe source" }],
          },
          explanation: {
            ruleId: "recipe.source",
            description:
              "The source display is normalized from the recipe's cookbook, website, or free-form source record.",
            readPath: "source",
            sourceDependencies: [
              { path: "source", label: "Normalized recipe source" },
            ],
          },
          validation: readOnly(rawRecipeTopLevelFields.source),
        },
        {
          key: "totals",
          storedKey: "totals",
          storedProjection: true,
          kind: "json",
          nullable: true,
          display: { list: false, detailLabelPath: "totalsLabel" },
          explanation: {
            ruleId: "recipe.totals",
            description:
              "These cost and nutrition totals are the stored costing result exposed for the current recipe inputs.",
            resolver: "recipeTotals",
            readPath: "totals",
            sourceDependencies: [
              { path: "storedResult", label: "Published recipe totals" },
            ],
          },
          validation: readOnly(recipeTotals.nullable().optional()),
        },
        // Flat preview projections of `totals` (`totalsPreview`): a partial
        // estimate shows what is known, anything else reads as absent.
        {
          key: "cost",
          kind: "number",
          nullable: true,
          display: {
            detail: false,
            list: false,
            preview: true,
            format: "currency",
          },
          validation: readOnly(
            z
              .number()
              .nullable()
              .default(null)
              .describe("Known cost of the totals, in dollars"),
          ),
        },
        {
          key: "calories",
          kind: "number",
          nullable: true,
          display: { detail: false, list: false, preview: true },
          validation: readOnly(
            z
              .number()
              .nullable()
              .default(null)
              .describe("Known kilocalories of the totals"),
          ),
        },
        {
          key: "protein",
          label: "Protein (g)",
          kind: "number",
          nullable: true,
          display: { detail: false, list: false, preview: true },
          validation: readOnly(
            z
              .number()
              .nullable()
              .default(null)
              .describe("Known grams of protein"),
          ),
        },
        {
          key: "carbs",
          label: "Carbs (g)",
          kind: "number",
          nullable: true,
          display: { detail: false, list: false, preview: true },
          validation: readOnly(
            z
              .number()
              .nullable()
              .default(null)
              .describe("Known grams of carbohydrate"),
          ),
        },
        {
          key: "fat",
          label: "Fat (g)",
          kind: "number",
          nullable: true,
          display: { detail: false, list: false, preview: true },
          validation: readOnly(
            z.number().nullable().default(null).describe("Known grams of fat"),
          ),
        },
        galleryImagesField("recipe", "Recipe", z.array(imageOut)),
        { output: false, key: "shortcode", kind: "text" },
        { output: false, key: "deletedAt", kind: "timestamp", nullable: true },
        {
          output: false,
          display: {},
          key: "sourceType",
          kind: "enum",
          nullable: true,
          readKey: "source",
        },
        {
          output: false,
          display: {},
          // A Website recipe's page. A Notion recipe's page id is an
          // EntityExternalId; a cookbook recipe names its Cookbook.
          key: "sourceUrl",
          kind: "text",
          nullable: true,
          readKey: "source",
        },
        {
          output: false,
          display: {},
          // The book a Book recipe came from when no Cookbook row exists.
          key: "sourceLabel",
          kind: "text",
          nullable: true,
          readKey: "source",
        },
        {
          output: false,
          audit: false,
          // Re-pointing a recipe at another cookbook (or none). Read through
          // `source`, so no read schema of its own.
          key: "cookbookId",
          kind: "identifier",
          nullable: true,
          reference: { entity: "cookbook" },
          control: { kind: "specialized", renderer: "entity-select" },
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
          display: { list: false },
          validation: {
            read: rawRecipeTopLevelFields.forkedFromRecipeId,
            create: recipeShortcode.nullable().optional(),
            update: recipeShortcode.nullable().optional(),
          },
        },
        // Derived, read-only: the forked-from recipe's name, joined at read time
        // (same "<ref>Id" + "<ref>Name" pairing as Task.parentTaskId/parentTaskName)
        // so the UI can render a real link label instead of a bare shortcode.
        {
          display: { detail: false, list: false },
          key: "forkedFromRecipeName",
          kind: "text",
          nullable: true,
          validation: readOnly(rawRecipeTopLevelFields.forkedFromRecipeName),
        },
        {
          output: false,
          key: "totalsComputedAt",
          kind: "timestamp",
          nullable: true,
        },
        {
          output: false,
          key: "totalsPublishedAt",
          kind: "timestamp",
          nullable: true,
        },
        {
          output: false,
          key: "activeMinutes",
          kind: "number",
          nullable: true,
          display: { list: false, readPath: "meta.times.activeMinutes" },
        },
        {
          output: false,
          key: "totalMinutes",
          kind: "number",
          nullable: true,
          // The cell prints the source's own time prose (recipe.meta.times.total)
          // when there is one, which doesn't always imply a present totalMinutes
          // count, so the server composes the text; sorting and the range filter
          // stay on the minute count.
          display: {
            columnGroup: "Per recipe",
            columnBar: true,
            detail: false,
            columnLabel: "Minutes",
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
        { ...labelField("costTotalLabel", "Recipe cost total"), output: false },
        {
          ...labelField("caloriesTotalLabel", "Recipe calorie total"),
          output: false,
        },
        {
          ...labelField("totalMinutesLabel", "Recipe time metadata"),
          output: false,
        },
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
        {
          key: "sourceType",
          specialized: "enum:sourceType",
          enum: { values: [...recipeSourceValues] },
        },
        "sourceUrl",
        "sourceLabel",
        "cookbookId",
        "forkedFromRecipeId",
        {
          key: "yield",
          specialized: "json:yield",
          type: {
            module: "@cubby/schemas/recipe-shared",
            export: "RecipeYield",
          },
        },
        "servings",
        {
          key: "tags",
          nullableOverride: false,
          defaultValue: "'{}'::text[]",
          specialized: "text-array",
        },
        "notes",
        {
          key: "totals",
          specialized: "json:totals",
          type: {
            module: "@cubby/schemas/recipe-shared",
            export: "StoredRecipeTotals",
          },
        },
        "totalsComputedAt",
        "totalsPublishedAt",
        "activeMinutes",
        "totalMinutes",
        {
          key: "meta",
          specialized: "json:meta",
          type: {
            module: "@cubby/schemas/recipe-shared",
            export: "RecipeStoredMeta",
          },
        },
      ],

      // Stored derived values that are not list fields (ADR 0021).
      stored: {
        totals: {
          compute: "recipe.totals",
          recordSource: {
            value: "totals",
            computedAt: "totalsPublishedAt",
            freshAt: "totalsComputedAt",
          },
          inputs: [
            {
              table: "EntityExternalId",
              match: { entityId: "id" },
              path: [
                { table: "Product", from: "id", to: "ingredientId" },
                {
                  table: "RecipeSectionIngredient",
                  from: "ingredientId",
                  to: "recipeSectionId",
                },
                { table: "RecipeSection", from: "id", to: "recipeId" },
              ],
              where: { entityKind: "product" },
            },
            {
              table: "Ingredient",
              match: { id: "id" },
              path: [
                {
                  table: "RecipeSectionIngredient",
                  from: "ingredientId",
                  to: "recipeSectionId",
                },
                { table: "RecipeSection", from: "id", to: "recipeId" },
              ],
            },
            {
              table: "Product",
              match: { ingredientId: "id" },
              columns: [
                "name",
                "shortcode",
                "ingredientId",
                "categoryId",
                "fdc_id",
                "labelNutrition",
                "usdaUnavailable",
                "price",
                "deletedAt",
              ],
              path: [
                {
                  table: "RecipeSectionIngredient",
                  from: "ingredientId",
                  to: "recipeSectionId",
                },
                { table: "RecipeSection", from: "id", to: "recipeId" },
              ],
            },

            {
              table: "Recipe",
              match: { id: "id" },
              // Its own output: publishing totals must not re-mark them.
              except: ["totals", "totalsComputedAt", "totalsPublishedAt"],
            },
            // A deleted sub-recipe publishes no totals, so mark its parents from the source row.
            {
              table: "Recipe",
              match: { id: "id" },
              columns: ["deletedAt"],
              path: [
                { table: "Ingredient", from: "recipeId", to: "id" },
                {
                  table: "RecipeSectionIngredient",
                  from: "ingredientId",
                  to: "recipeSectionId",
                },
                { table: "RecipeSection", from: "id", to: "recipeId" },
              ],
            },
            { table: "RecipeSection", match: { recipeId: "id" } },
            {
              table: "RecipeSectionIngredient",
              match: { recipeSectionId: "id" },
              path: [{ table: "RecipeSection", from: "id", to: "recipeId" }],
            },
            {
              table: "ProductUnitMapping",
              match: { productId: "id" },
              path: [
                { table: "Product", from: "id", to: "ingredientId" },
                {
                  table: "RecipeSectionIngredient",
                  from: "ingredientId",
                  to: "recipeSectionId",
                },
                { table: "RecipeSection", from: "id", to: "recipeId" },
              ],
            },
          ],
          dependsOn: [
            {
              entity: "product",
              key: "price",
              path: [
                { table: "Product", from: "id", to: "ingredientId" },
                {
                  table: "RecipeSectionIngredient",
                  from: "ingredientId",
                  to: "recipeSectionId",
                },
                { table: "RecipeSection", from: "id", to: "recipeId" },
              ],
            },
            {
              entity: "recipe",
              key: "totals",
              path: [
                { table: "Ingredient", from: "recipeId", to: "id" },
                {
                  table: "RecipeSectionIngredient",
                  from: "ingredientId",
                  to: "recipeSectionId",
                },
                { table: "RecipeSection", from: "id", to: "recipeId" },
              ],
            },
          ],
        },
      },
      derived: {
        cookbook: { via: "cookbook" },
        // Totals order only once computed; until then they read as absent.
        costTotal: { type: "number" },
        caloriesTotal: { type: "number" },
        // Source kind, then its URL, then its label.
        source: { type: "text" },
        // The first tag.
        tags: { type: "text" },
        // Planned on a live meal.
        meals: { type: "boolean" },
        // A displayable image (PDFs don't count).
        image: { type: "boolean" },
        // A live section with written instructions.
        instructions: { type: "boolean" },
        // Used as an ingredient line of another live recipe.
        subRecipe: { type: "boolean" },
      },
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
      },
      grouping: ["cookbook", "tags"],
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
    },
    fields: {
      embedded: [
        {
          path: ["images"],
          entity: "image",
          projections: ["output", "detail", "mcpOutput", "mcpDetail"],
        },
        {
          path: ["sections", "ingredients", "recipe"],
          entity: "recipe",
          projections: ["output", "detail", "mcpOutput", "mcpDetail"],
        },
      ],

      output: {
        module: "@cubby/schemas/recipe-raw-read",
        export: "rawRecipeOutput",
      },

      mcpOutput: {
        module: "@cubby/schemas/recipe-raw-read",
        export: "rawRecipeMcpOutput",
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
          columnId: "forkedFromRecipeId",
          kind: "idMulti",
          deriveSchema: true,
          brandRef: { entity: "recipe" },
          placeholder: "Filter by forked-from recipe...",
        },
        {
          columnId: "name",
          field: "nameFilter",
          kind: "text",
          placeholder: "Filter by recipe name...",
          deriveSchema: true,
          anyOf: ["name", "notes"],
        },
        {
          columnId: "tags",
          field: "tagFilters",
          kind: "multiselect",
          placeholder: "Filter by tag...",
          optionsKey: "tags",
          deriveSchema: true,
          stored: { array: true },
        },
        {
          columnId: "source",
          field: "cookbookId",
          kind: "idMulti",
          placeholder: "Filter by cookbook...",
          brandRef: { entity: "cookbook" },
          deriveSchema: true,
          stored: { columns: ["cookbookId"] },
        },
        {
          // "What can I make?" drops sub-recipes: a component, not a meal.
          columnId: "subRecipe",
          kind: "boolean",
          placeholder: "Filter sub-recipes...",
          deriveSchema: true,
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
          deriveSchema: true,
        },
        {
          columnId: "costTotal",
          kind: "range",
          // The hand-written request schema rejects negative bounds.
          range: { kind: "number", nonnegative: true },
          derived: true,
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
          // The hand-written request schema rejects negative bounds.
          range: { kind: "number", nonnegative: true },
          derived: true,
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
          optionSource: { kind: "relation", relationKey: "recipe.ingredients" },
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
        },
        {
          columnId: "mealPresenceFilter",
          kind: "presence",
          placeholder: "Filter related meals presence...",
        },
      ],
    },

    search: {
      mode: "semantic",
      inputs: [
        ...imageDescriptionInputs("recipe"),

        {
          table: "RecipeSection",
          match: { recipeId: "id" },
          columns: ["deletedAt", "instructions"],
        },
        {
          table: "RecipeSectionIngredient",
          match: { recipeSectionId: "id" },
          path: [{ table: "RecipeSection", from: "id", to: "recipeId" }],
        },
        {
          table: "Ingredient",
          match: { id: "id" },
          columns: ["name", "deletedAt"],
          path: [
            {
              table: "RecipeSectionIngredient",
              from: "ingredientId",
              to: "recipeSectionId",
            },
            { table: "RecipeSection", from: "id", to: "recipeId" },
          ],
        },
      ],
    },
    capabilities: {
      images: {
        storage: "gallery",
        displaySources: [
          {
            relationPath: ["meals"],
            ordering: "newest",
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
      delete: { mode: "soft", bulk: true },
      merge: false,
      dataQuality: {
        // Rows the stored evaluator reads beyond its own row (ADR 0021).
        inputs: [
          {
            table: "MealRecipe",
            match: { recipeId: "id" },
            columns: ["deletedAt", "mealId"],
            path: [{ table: "Recipe", from: "id", to: "id" }],
          },
          {
            table: "Meal",
            match: { id: "id" },
            columns: ["deletedAt", "id"],
            path: [
              { table: "MealRecipe", from: "mealId", to: "recipeId" },
              { table: "Recipe", from: "id", to: "id" },
            ],
          },
          ...attachedImageInputs([
            { table: "Meal", from: "id", to: "id" },
            { table: "MealRecipe", from: "mealId", to: "recipeId" },
            { table: "Recipe", from: "id", to: "id" },
          ]),
          {
            table: "RecipeSection",
            match: { recipeId: "id" },
            columns: ["deletedAt", "instructions"],
          },
          {
            table: "RecipeSectionIngredient",
            match: { recipeSectionId: "id" },
            path: [{ table: "RecipeSection", from: "id", to: "recipeId" }],
          },
          {
            table: "Ingredient",
            match: { id: "id" },
            columns: ["name", "deletedAt"],
            path: [
              {
                table: "RecipeSectionIngredient",
                from: "ingredientId",
                to: "recipeSectionId",
              },
              { table: "RecipeSection", from: "id", to: "recipeId" },
            ],
          },
          { table: "RecipeSection", match: { recipeId: "id" } },
        ],
        checks: [
          {
            id: "recipe_ingredients",
            satisfiedLabel: "Ingredients recorded",
            placement: { section: "contents" },
            facet: "content",
            label: "Ingredients",
            message: "No ingredient line names a live ingredient.",
          },
          {
            id: "recipe_instructions",
            satisfiedLabel: "Instructions recorded",
            placement: { section: "contents" },
            facet: "content",
            label: "Instructions",
            message: "No written instructions are recorded.",
          },
          {
            id: "recipe_source",
            satisfiedLabel: "Source recorded",
            placement: { field: "source" },
            facet: "provenance",
            label: "Source",
            message: "No recipe source is recorded.",
          },
        ],
      },
    },
    extensions: {
      relatednessSignals: [
        { kind: "semantic", label: "Similar meaning", weight: 1, limit: 8 },
        {
          kind: "scalarOverlap",
          label: "Shared tag",
          field: "tags",
          popularityCap: 24,
          scoring: "displayOnly",
        },
      ],
      ports: {
        reports: {
          module: "~/server/domains/recipe/repo/report-bindings",
          export: "reportBindings",
        },
        repository: {
          module: "~/server/domains/recipe/repo/repository",
          export: "recipeRepository",
        },
        search: "document",
      },
    },
  },
  recipeReadSchemas,
);

export default defineEntity(
  definition,
  (r) => ({
    edges: [
      r.declare(
        r.field("cookbookId").named("cookbook", "Cookbook"),
        "cookbook.recipes",
      ),
      r.declare(
        r.field("forkedFromRecipeId").named("forkedFrom", "Forked from", {
          inverseOmit:
            "The recipe page is custom; a recipe's forks are reached from each fork's Forked from field.",
        }),
        "recipe.recipe.forkedFrom",
      ),
      r.declare(r.images(), "image.recipe.images"),
      r.declare(
        r
          .path("ingredient", "many", [
            { edge: "RecipeSection.recipeId", direction: "incoming" },
            {
              edge: "RecipeSectionIngredient.recipeSectionId",
              direction: "incoming",
            },
            {
              edge: "RecipeSectionIngredient.ingredientId",
              direction: "outgoing",
            },
          ])
          .named("ingredients", "Ingredients", {
            view: { columnGroup: "Recipe" },
          }),
        "ingredient.recipes",
      ),
      r.declare(
        r
          .path("recipe", "many", [
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
          ])
          .named("sub-recipes", "Sub-recipes"),
        "recipe.recipe.sub-recipes",
      ),
      r.declare(
        r
          .path("meal", "many", [
            { edge: "MealRecipe.recipeId", direction: "incoming" },
            { edge: "MealRecipe.mealId", direction: "outgoing" },
          ])
          .named("meals", "Meals", {
            view: {
              columnGroup: "Source & use",
              order: "newest",
              inverseKey: "meal.recipes",
            },
            sources: [
              r
                .path("meal", "many", [
                  { edge: "MealRecipe.recipeId", direction: "incoming" },
                  {
                    edge: "MealRecipePortion.mealRecipeId",
                    direction: "incoming",
                  },
                  { edge: "MealRecipePortion.mealId", direction: "outgoing" },
                ])
                .source("served-portions", "Served portions"),
            ],
          }),
        "meal.recipes",
      ),
    ],
  }),
  readSchemas,
);

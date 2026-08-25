import { literalEntity } from "../literal.js";

export default literalEntity({
  key: "recipe",
  names: { singular: "Recipe" },
  route: { basePath: "recipes" },
  table: "Recipe",
  identifiers: { brand: "RecipeId", shortcode: "RCP-", legacy: null },
  presentation: { titleField: "name" },
  fields: {
    create: { module: "@cubby/schemas/recipe", export: "recipeCreateInput" },
    update: { module: "@cubby/schemas/recipe", export: "recipeUpdateData" },
    output: { module: "@cubby/schemas/recipe", export: "recipeOut" },
    list: { module: "@cubby/schemas/recipe", export: "recipeListItemOut" },
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
      },
      {
        columnId: "tags",
        field: "tagFilters",
        kind: "multiselect",
        placeholder: "Filter by tag...",
        optionsKey: "tags",
        nullable: { field: "tagsPresenceFilter", label: "tags" },
      },
      {
        columnId: "source",
        field: "cookbookId",
        kind: "idMulti",
        placeholder: "Filter by cookbook...",
        optionsKey: "cookbook",
        brandRef: {
          module: "@cubby/schemas/identifiers",
          export: "unsafeCookbookId",
        },
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
          { value: "under10", label: "Under $10" },
          { value: "10to25", label: "$10–$25" },
          { value: "25plus", label: "$25 and up" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveRecipeCost",
        },
      },
      {
        columnId: "caloriesTotal",
        kind: "range",
        placeholder: "Filter calories...",
        options: [
          { value: "under500", label: "Under 500 cal" },
          { value: "500to1000", label: "500–1,000 cal" },
          { value: "1000plus", label: "1,000+ cal" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveCalories",
        },
      },
      {
        columnId: "totalMinutes",
        kind: "range",
        placeholder: "Filter total time...",
        options: [
          { value: "under30", label: "Under 30 min" },
          { value: "30to60", label: "30–60 min" },
          { value: "60plus", label: "Over an hour" },
        ],
        expandRef: {
          module: "~/entities/filter-behavior",
          export: "resolveRecipeTotalTime",
        },
      },
      {
        columnId: "related:recipe.ingredients",
        field: "ingredientId",
        urlKey: "related-ingredient",
        kind: "idMulti",
        placeholder: "Filter by ingredient...",
        optionsKey: "recipeIngredients",
        brandRef: {
          module: "@cubby/schemas/identifiers",
          export: "unsafeIngredientId",
        },
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
      provenance: {
        kind: "local-path",
        steps: [{ edge: "Recipe.cookbookId", direction: "outgoing" }],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [{ edge: "Recipe.cookbookId", direction: "incoming" }],
      },
    },
    {
      key: "images",
      label: "Images",
      target: "image",
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "RecipeImage.recipeId", direction: "incoming" },
          { edge: "RecipeImage.imageId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "RecipeImage.imageId", direction: "incoming" },
          { edge: "RecipeImage.recipeId", direction: "outgoing" },
        ],
      },
    },
    {
      key: "ingredients",
      label: "Ingredients",
      target: "ingredient",
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
      deletionPolicy: "restrict",
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
      deletionPolicy: "restrict",
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
      provenance: {
        kind: "local-path",
        steps: [
          { edge: "MealRecipe.recipeId", direction: "incoming" },
          { edge: "MealRecipe.mealId", direction: "outgoing" },
        ],
      },
      deletionPolicy: "restrict",
      inverse: {
        steps: [
          { edge: "MealRecipe.mealId", direction: "incoming" },
          { edge: "MealRecipe.recipeId", direction: "outgoing" },
        ],
      },
    },
  ],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: true,
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    merge: false,
    mcp: ["get", "list", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: { overrides: { delete: "delete_recipe" } },
    ports: {
      repository: {
        module: "~/server/repo/recipe/entity-adapter",
        export: "recipeEntityAdapter",
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
      lifecycle: {
        policy: {
          module: "~/server/repo/recipe/crud",
          export: "RECIPE_DELETE_EDGE_POLICY",
        },
        runtime: {
          module: "~/server/repo/recipe/entity-adapter",
          export: "recipeEntityAdapter",
        },
      },
      relationMutation: { attach: null, detach: null },
    },
  },
});

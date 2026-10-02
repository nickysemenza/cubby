import { defineChildTable } from "../entity-definitions/child-definition.js";

export const recipeChildren = [
  defineChildTable({
    name: "RecipeSection",
    exportName: "recipeSection",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "recipeId",
        kind: "uuid",
        notNull: true,
        type: "RecipeId",
        reference: { table: "recipe", column: "id" },
      },
      { key: "name", kind: "text" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
      { key: "deletedAt", kind: "timestamp" },
      {
        key: "instructions",
        kind: "jsonb",
        notNull: true,
        type: "Instruction[]",
        default: { sql: "'[]'::jsonb" },
      },
      // Position within the recipe. Nullable: rows saved before this column was
      // added have no recoverable order (createdAt is the transaction timestamp,
      // identical across one save) — reads tiebreak on createdAt/id for those.
      { key: "sortOrder", kind: "integer" },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["RecipeId"] },
      { module: "../schema", exports: ["Instruction"] },
    ],
    indexes: [
      { name: "RecipeSection_recipeId_idx", on: ["recipeId"] },
      { name: "RecipeSection_createdAt_idx", on: ["createdAt"] },
    ],
    relations: [
      {
        name: "recipe",
        kind: "one",
        table: "recipe",
        fields: ["recipeId"],
        references: ["id"],
      },
      { name: "ingredients", kind: "many", table: "recipeSectionIngredient" },
    ],
  }),
  defineChildTable({
    name: "RecipeSectionIngredient",
    exportName: "recipeSectionIngredient",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "recipeSectionId",
        kind: "uuid",
        notNull: true,
        reference: { table: "recipeSection", column: "id" },
      },
      {
        key: "ingredientId",
        kind: "uuid",
        notNull: true,
        type: "IngredientId",
        reference: { table: "ingredient", column: "id" },
      },
      {
        key: "amounts",
        kind: "jsonb",
        notNull: true,
        type: "Amount[]",
        default: { sql: "'[]'::jsonb" },
      },
      // Raw, unparsed ingredient line as it arrived from the scraper/cookbook
      // import, plus the parser-derived modifier (e.g. "finely chopped") that is
      // otherwise discarded. Retained so a future parser upgrade can be re-applied
      // to existing rows without re-importing the source. Nullable: only populated
      // for rows created after this column was added.
      { key: "rawLine", kind: "text" },
      { key: "modifier", kind: "text" },
      { key: "sortOrder", kind: "integer" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
      { key: "deletedAt", kind: "timestamp" },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["IngredientId"] },
      { module: "@cubby/schemas/codec", exports: ["Amount"] },
    ],
    indexes: [
      {
        name: "RecipeSectionIngredient_recipeSectionId_idx",
        on: ["recipeSectionId"],
      },
      {
        name: "RecipeSectionIngredient_ingredientId_idx",
        on: ["ingredientId"],
      },
    ],
    relations: [
      {
        name: "recipeSection",
        kind: "one",
        table: "recipeSection",
        fields: ["recipeSectionId"],
        references: ["id"],
      },
      {
        name: "ingredient",
        kind: "one",
        table: "ingredient",
        fields: ["ingredientId"],
        references: ["id"],
      },
    ],
  }),
];

import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const usdaFood = sqliteTable(
  "usda_food",
  {
    fdc_id: integer("fdc_id").primaryKey(),
    data_type: text("data_type").notNull(),
    description: text("description").notNull(),
    food_category_id: text("food_category_id"),
    publication_date: text("publication_date").notNull(),
  },
  (t) => ({
    fdcIdIdx: index("food_fdc_id").on(t.fdc_id),
    descriptionIdx: index("usda_food_description_idx").on(t.description),
    dataTypeIdx: index("usda_food_data_type_idx").on(t.data_type),
  }),
);

export const usdaBrandedFood = sqliteTable(
  "usda_branded_food",
  {
    fdc_id: integer("fdc_id")
      .primaryKey()
      .references(() => usdaFood.fdc_id, {
        onDelete: "no action",
        onUpdate: "no action",
      }),
    brand_owner: text("brand_owner"),
    brand_name: text("brand_name"),
    subbrand_name: text("subbrand_name"),
    gtin_upc: text("gtin_upc").notNull(),
    ingredients: text("ingredients"),
    not_a_significant_source_of: text("not_a_significant_source_of"),
    serving_size: real("serving_size"),
    serving_size_unit: text("serving_size_unit"),
    household_serving_fulltext: text("household_serving_fulltext"),
    branded_food_category: text("branded_food_category"),
    data_source: text("data_source"),
    package_weight: text("package_weight"),
    modified_date: text("modified_date"),
    available_date: text("available_date"),
    market_country: text("market_country"),
    discontinued_date: text("discontinued_date"),
    preparation_state_code: text("preparation_state_code"),
    trade_channel: text("trade_channel"),
    short_description: text("short_description"),
    material_code: text("material_code"),
  },
  (t) => ({
    fdcIdIdx: index("branded_food_fdc_id").on(t.fdc_id),
    upcIdx: index("branded_food_upc").on(t.gtin_upc),
  }),
);

export const usdaNutrient = sqliteTable("usda_nutrient", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  unit_name: text("unit_name").notNull(),
  nutrient_nbr: text("nutrient_nbr"),
  rank: text("rank"),
});

export const usdaFoodNutrient = sqliteTable(
  "usda_food_nutrient",
  {
    id: integer("id").primaryKey(),
    fdc_id: integer("fdc_id").references(() => usdaFood.fdc_id, {
      onDelete: "no action",
      onUpdate: "no action",
    }),
    nutrient_id: integer("nutrient_id").references(() => usdaNutrient.id, {
      onDelete: "no action",
      onUpdate: "no action",
    }),
    amount: real("amount").notNull(),
    data_points: text("data_points"),
    derivation_id: text("derivation_id"),
    min: text("min"),
    max: text("max"),
    median: text("median"),
    loq: text("loq"),
    footnote: text("footnote"),
    min_year_acquired: text("min_year_acquired"),
    percent_daily_value: text("percent_daily_value"),
  },
  (t) => ({
    fdcIdIdx: index("food_nutrient_fdc_id").on(t.fdc_id),
    nutrientIdIdx: index("food_nutrient_nutrient_id_idx").on(t.nutrient_id),
  }),
);

export const usdaMeasureUnit = sqliteTable("usda_measure_unit", {
  id: integer("id").primaryKey(),
  name: text("name"),
});

export const usdaFoodPortion = sqliteTable(
  "usda_food_portion",
  {
    id: integer("id").primaryKey(),
    fdc_id: integer("fdc_id").references(() => usdaFood.fdc_id, {
      onDelete: "no action",
      onUpdate: "no action",
    }),
    seq_num: text("seq_num"),
    amount: real("amount").notNull(),
    measure_unit_id: integer("measure_unit_id").references(
      () => usdaMeasureUnit.id,
      {
        onDelete: "no action",
        onUpdate: "no action",
      },
    ),
    portion_description: text("portion_description"),
    modifier: text("modifier"),
    gram_weight: real("gram_weight").notNull(),
    data_points: text("data_points"),
    footnote: text("footnote"),
    min_year_acquired: text("min_year_acquired"),
  },
  (t) => ({
    fdcIdIdx: index("food_portion_fdc_id").on(t.fdc_id),
    measureUnitIdx: index("food_portion_measure_unit_id_idx").on(
      t.measure_unit_id,
    ),
  }),
);

export const usdaSrLegacyFood = sqliteTable(
  "usda_sr_legacy_food",
  {
    fdc_id: integer("fdc_id").primaryKey(),
    NDB_number: integer("NDB_number").notNull(),
  },
  (t) => ({
    ndbUnique: uniqueIndex("usda_sr_legacy_food_NDB_number_unique").on(
      t.NDB_number,
    ),
  }),
);

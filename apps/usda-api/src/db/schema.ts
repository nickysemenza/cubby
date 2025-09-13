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
    fdcId: integer("fdc_id").primaryKey(),
    dataType: text("data_type").notNull(),
    description: text("description"),
    foodCategoryId: text("food_category_id"),
    publicationDate: text("publication_date").notNull(),
  },
  (t) => ({
    fdcIdIdx: index("food_fdc_id").on(t.fdcId),
    descriptionIdx: index("usda_food_description_idx").on(t.description),
    dataTypeIdx: index("usda_food_data_type_idx").on(t.dataType),
  }),
);

export const usdaBrandedFood = sqliteTable(
  "usda_branded_food",
  {
    fdcId: integer("fdc_id")
      .primaryKey()
      .references(() => usdaFood.fdcId, {
        onDelete: "no action",
        onUpdate: "no action",
      }),
    brandOwner: text("brand_owner"),
    brandName: text("brand_name"),
    subbrandName: text("subbrand_name"),
    gtinUpc: text("gtin_upc").notNull(),
    ingredients: text("ingredients"),
    notASignificantSourceOf: text("not_a_significant_source_of"),
    servingSize: real("serving_size"),
    servingSizeUnit: text("serving_size_unit"),
    householdServingFulltext: text("household_serving_fulltext"),
    brandedFoodCategory: text("branded_food_category"),
    dataSource: text("data_source"),
    packageWeight: text("package_weight"),
    modifiedDate: text("modified_date"),
    availableDate: text("available_date"),
    marketCountry: text("market_country"),
    discontinuedDate: text("discontinued_date"),
    preparationStateCode: text("preparation_state_code"),
    tradeChannel: text("trade_channel"),
    shortDescription: text("short_description"),
    materialCode: text("material_code"),
  },
  (t) => ({
    fdcIdIdx: index("branded_food_fdc_id").on(t.fdcId),
    upcIdx: index("branded_food_upc").on(t.gtinUpc),
  }),
);

export const usdaNutrient = sqliteTable("usda_nutrient", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  unitName: text("unit_name").notNull(),
  nutrientNbr: text("nutrient_nbr"),
  rank: text("rank"),
});

export const usdaFoodNutrient = sqliteTable(
  "usda_food_nutrient",
  {
    id: integer("id").primaryKey(),
    fdcId: integer("fdc_id")
      .notNull()
      .references(() => usdaFood.fdcId, {
        onDelete: "no action",
        onUpdate: "no action",
      }),
    nutrientId: integer("nutrient_id")
      .notNull()
      .references(() => usdaNutrient.id, {
        onDelete: "no action",
        onUpdate: "no action",
      }),
    amount: real("amount").notNull(),
    dataPoints: text("data_points"),
    derivationId: text("derivation_id"),
    min: text("min"),
    max: text("max"),
    median: text("median"),
    loq: text("loq"),
    footnote: text("footnote"),
    minYearAcquired: text("min_year_acquired"),
    percentDailyValue: text("percent_daily_value"),
  },
  (t) => ({
    fdcIdIdx: index("food_nutrient_fdc_id").on(t.fdcId),
    nutrientIdIdx: index("food_nutrient_nutrient_id_idx").on(t.nutrientId),
  }),
);

export const usdaMeasureUnit = sqliteTable("usda_measure_unit", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const usdaFoodPortion = sqliteTable(
  "usda_food_portion",
  {
    id: integer("id").primaryKey(),
    fdcId: integer("fdc_id")
      .notNull()
      .references(() => usdaFood.fdcId, {
        onDelete: "no action",
        onUpdate: "no action",
      }),
    seqNum: text("seq_num"),
    amount: real("amount"),
    measureUnitId: integer("measure_unit_id")
      .notNull()
      .references(() => usdaMeasureUnit.id, {
        onDelete: "no action",
        onUpdate: "no action",
      }),
    portionDescription: text("portion_description"),
    modifier: text("modifier"),
    gramWeight: real("gram_weight").notNull(),
    dataPoints: text("data_points"),
    footnote: text("footnote"),
    minYearAcquired: text("min_year_acquired"),
  },
  (t) => ({
    fdcIdIdx: index("food_portion_fdc_id").on(t.fdcId),
    measureUnitIdx: index("food_portion_measure_unit_id_idx").on(
      t.measureUnitId,
    ),
  }),
);

export const usdaSrLegacyFood = sqliteTable(
  "usda_sr_legacy_food",
  {
    fdcId: integer("fdc_id").primaryKey(),
    ndbNumber: integer("NDB_number").notNull(),
  },
  (t) => ({
    ndbUnique: uniqueIndex("usda_sr_legacy_food_NDB_number_unique").on(
      t.ndbNumber,
    ),
  }),
);

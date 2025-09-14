import { eq, and, asc, desc, count, sql, isNotNull } from "drizzle-orm";
import { db } from "./client";
import * as schema from "./schema";
import { toFtsQuery } from "./fts";
import type { z } from "zod";
import { nutrient_unit_name, type DataType } from "@recipehub/usda-schemas";
import { foodSearch } from "./types";

// Drizzle prepared statements for better performance and type safety
const preparedStatements = {
  // FTS5 queries using Drizzle's sql operator for MATCH queries
  ftsWithDataType: db
    .select({
      fdc_id: foodSearch.fdc_id,
      data_type: foodSearch.data_type,
      description: foodSearch.description,
    })
    .from(foodSearch)
    .where(
      and(
        sql`${foodSearch} MATCH ${sql.placeholder("query")}`,
        eq(foodSearch.data_type, sql.placeholder("dataType")),
      ),
    )
    .orderBy(asc(foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsWithDataTypeDesc: db
    .select({
      fdc_id: foodSearch.fdc_id,
      data_type: foodSearch.data_type,
      description: foodSearch.description,
    })
    .from(foodSearch)
    .where(
      and(
        sql`${foodSearch} MATCH ${sql.placeholder("query")}`,
        eq(foodSearch.data_type, sql.placeholder("dataType")),
      ),
    )
    .orderBy(desc(foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsCountWithDataType: db
    .select({ count: count() })
    .from(foodSearch)
    .where(
      and(
        sql`${foodSearch} MATCH ${sql.placeholder("query")}`,
        eq(foodSearch.data_type, sql.placeholder("dataType")),
      ),
    )
    .prepare(),

  ftsNoFilter: db
    .select({
      fdc_id: foodSearch.fdc_id,
      data_type: foodSearch.data_type,
      description: foodSearch.description,
    })
    .from(foodSearch)
    .where(sql`${foodSearch} MATCH ${sql.placeholder("query")}`)
    .orderBy(asc(foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsNoFilterDesc: db
    .select({
      fdc_id: foodSearch.fdc_id,
      data_type: foodSearch.data_type,
      description: foodSearch.description,
    })
    .from(foodSearch)
    .where(sql`${foodSearch} MATCH ${sql.placeholder("query")}`)
    .orderBy(desc(foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsCount: db
    .select({ count: count() })
    .from(foodSearch)
    .where(sql`${foodSearch} MATCH ${sql.placeholder("query")}`)
    .prepare(),

  // Standard table queries using Drizzle query builder
  getFoodByIdStmt: db
    .select({
      fdc_id: schema.usdaFood.fdc_id,
      data_type: schema.usdaFood.data_type,
      description: schema.usdaFood.description,
    })
    .from(schema.usdaFood)
    .where(eq(schema.usdaFood.fdc_id, sql.placeholder("fdcId")))
    .prepare(),

  getBrandedFoodByIdStmt: db
    .select({
      fdc_id: schema.usdaBrandedFood.fdc_id,
      brand_owner: schema.usdaBrandedFood.brand_owner,
      brand_name: schema.usdaBrandedFood.brand_name,
      branded_food_category: schema.usdaBrandedFood.branded_food_category,
      gtin_upc: schema.usdaBrandedFood.gtin_upc,
      ingredients: schema.usdaBrandedFood.ingredients,
      serving_size: schema.usdaBrandedFood.serving_size,
      serving_size_unit: schema.usdaBrandedFood.serving_size_unit,
      household_serving_fulltext:
        schema.usdaBrandedFood.household_serving_fulltext,
      modified_date:
        sql<string>`COALESCE(${schema.usdaBrandedFood.modified_date}, datetime('now'))`.as(
          "modified_date",
        ),
    })
    .from(schema.usdaBrandedFood)
    .where(eq(schema.usdaBrandedFood.fdc_id, sql.placeholder("fdcId")))
    .prepare(),

  getLegacyFoodByIdStmt: db
    .select({
      fdc_id: schema.usdaSrLegacyFood.fdc_id,
      ndb_number: schema.usdaSrLegacyFood.NDB_number,
    })
    .from(schema.usdaSrLegacyFood)
    .where(eq(schema.usdaSrLegacyFood.fdc_id, sql.placeholder("fdcId")))
    .prepare(),

  getFoodPortionsStmt: db
    .select({
      amount: schema.usdaFoodPortion.amount,
      modifier: schema.usdaFoodPortion.modifier,
      gram_weight: schema.usdaFoodPortion.gram_weight,
    })
    .from(schema.usdaFoodPortion)
    .where(
      and(
        eq(schema.usdaFoodPortion.fdc_id, sql.placeholder("fdcId")),
        isNotNull(schema.usdaFoodPortion.gram_weight),
      ),
    )
    .prepare(),

  getNutrientsStmt: db
    .select({
      amount: schema.usdaFoodNutrient.amount,
      name: schema.usdaNutrient.name,
      unit: schema.usdaNutrient.unit_name,
      nutrient_nbr: schema.usdaNutrient.nutrient_nbr,
    })
    .from(schema.usdaFoodNutrient)
    .innerJoin(
      schema.usdaNutrient,
      eq(schema.usdaFoodNutrient.nutrient_id, schema.usdaNutrient.id),
    )
    .where(eq(schema.usdaFoodNutrient.fdc_id, sql.placeholder("fdcId")))
    .prepare(),
};

// 6. Find Food by UPC - returns complete food info
export const findFoodByUpc = (gtinUpc: string) => {
  const result = db
    .select({
      fdc_id: schema.usdaBrandedFood.fdc_id,
    })
    .from(schema.usdaBrandedFood)
    .where(eq(schema.usdaBrandedFood.gtin_upc, gtinUpc))
    .get();

  if (!result) return null;

  // Return complete food info for the found FDC ID
  return getCompleteFoodInfo(result.fdc_id);
};

// 7. Find Food by NDB Number - returns complete food info
export const findFoodByNdb = (ndbNumber: number) => {
  const result = db
    .select({
      fdc_id: schema.usdaSrLegacyFood.fdc_id,
    })
    .from(schema.usdaSrLegacyFood)
    .where(eq(schema.usdaSrLegacyFood.NDB_number, ndbNumber))
    .get();

  if (!result) return null;

  // Return complete food info for the found FDC ID
  return getCompleteFoodInfo(result.fdc_id);
};

// 8. List Foods with Pagination and Filtering
export const listFoods = ({
  nameFilter,
  dataTypeFilter,
  orderBy = "description",
  direction = "asc",
  pageIndex = 0,
  pageSize = 10,
}: {
  nameFilter?: string;
  dataTypeFilter?: DataType;
  orderBy?: "description" | "data_type" | "fdc_id";
  direction?: "asc" | "desc";
  pageIndex?: number;
  pageSize?: number;
}) => {
  // If nameFilter is present, use enhanced FTS for fast search
  if (nameFilter && nameFilter.trim().length > 0) {
    const ftsQuery = toFtsQuery(nameFilter);

    if (dataTypeFilter) {
      // With data_type filter
      const stmt =
        direction === "desc"
          ? preparedStatements.ftsWithDataTypeDesc
          : preparedStatements.ftsWithDataType;

      const rows = stmt.all({
        query: ftsQuery,
        dataType: dataTypeFilter,
        limit: pageSize,
        offset: pageIndex * pageSize,
      });

      const totalCountResult = preparedStatements.ftsCountWithDataType.get({
        query: ftsQuery,
        dataType: dataTypeFilter,
      });

      // Get complete food data for each item
      const completeData = rows
        .filter((row) => row.fdc_id !== null)
        .map((row) => getCompleteFoodInfo(row.fdc_id!))
        .filter((item): item is NonNullable<typeof item> => item !== null);

      return { data: completeData, count: totalCountResult?.count ?? 0 };
    } else {
      // Without data_type filter: can use FTS table directly (faster)
      const stmt =
        direction === "desc"
          ? preparedStatements.ftsNoFilterDesc
          : preparedStatements.ftsNoFilter;

      const rows = stmt.all({
        query: ftsQuery,
        limit: pageSize,
        offset: pageIndex * pageSize,
      });

      const totalCountResult = preparedStatements.ftsCount.get({
        query: ftsQuery,
      });

      // Get complete food data for each item
      const completeData = rows
        .filter((row) => row.fdc_id !== null)
        .map((row) => getCompleteFoodInfo(row.fdc_id!))
        .filter((item): item is NonNullable<typeof item> => item !== null);

      return { data: completeData, count: totalCountResult?.count ?? 0 };
    }
  }

  // No name filter: fall back to indexed exact filters and ordering via drizzle
  const conditions: Parameters<typeof and> = [];
  if (dataTypeFilter) {
    conditions.push(eq(schema.usdaFood.data_type, dataTypeFilter));
  }

  const baseQuery = db
    .select({
      fdc_id: schema.usdaFood.fdc_id,
      data_type: schema.usdaFood.data_type,
      description: schema.usdaFood.description,
    })
    .from(schema.usdaFood);

  let finalQuery = baseQuery;
  if (conditions.length > 0) {
    finalQuery = finalQuery.where(and(...conditions)) as typeof baseQuery;
  }

  const orderColumn = {
    description: schema.usdaFood.description,
    data_type: schema.usdaFood.data_type,
    fdc_id: schema.usdaFood.fdc_id,
  }[orderBy];

  finalQuery = finalQuery.orderBy(
    direction === "desc" ? desc(orderColumn) : asc(orderColumn),
  ) as typeof baseQuery;

  const data = finalQuery
    .limit(pageSize)
    .offset(pageIndex * pageSize)
    .all();

  // Get complete food data for each item
  const completeData = data
    .map((row) => getCompleteFoodInfo(row.fdc_id))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const baseCountQuery = db.select({ count: count() }).from(schema.usdaFood);
  let countQuery = baseCountQuery;
  if (conditions.length > 0) {
    countQuery = countQuery.where(and(...conditions)) as typeof baseCountQuery;
  }
  const totalCount = countQuery.get()?.count ?? 0;

  return { data: completeData, count: totalCount };
};

// Optimized composite query for complete food info - uses Drizzle prepared statements
export const getCompleteFoodInfo = (fdcId: number) => {
  // Get basic food info first
  const foodInfo = preparedStatements.getFoodByIdStmt.get({ fdcId });
  if (!foodInfo) return null;

  // Execute all other queries using prepared statements (much faster than individual function calls)
  const brandedInfo = preparedStatements.getBrandedFoodByIdStmt.get({ fdcId });
  const legacyInfo = preparedStatements.getLegacyFoodByIdStmt.get({ fdcId });
  const portions = preparedStatements.getFoodPortionsStmt.all({ fdcId });
  const nutrients = preparedStatements.getNutrientsStmt.all({ fdcId });

  // Process nutrients for per100 calculations
  const proteinNutrient = nutrients.find((n) => n.nutrient_nbr === "203");
  const energyNutrient = nutrients.find((n) => n.nutrient_nbr === "208");

  const nutritionInfo = {
    nutrientSummary: nutrients.map((n) => ({
      amount: n.amount,
      name: n.name,
      unit: n.unit as z.infer<typeof nutrient_unit_name>,
    })),
    nutrientsPer100: {
      protein: proteinNutrient?.amount || 0,
      kcal: energyNutrient?.amount || 0,
    },
  };

  return {
    fdc_id: fdcId,
    foodInfo: {
      data_type: foodInfo.data_type,
      description: foodInfo.description,
    },
    brandedFoodInfo: brandedInfo
      ? {
          brand_owner: brandedInfo.brand_owner,
          brand_name: brandedInfo.brand_name,
          branded_food_category: brandedInfo.branded_food_category,
          gtin_upc: brandedInfo.gtin_upc,
          ingredients: brandedInfo.ingredients,
          serving: {
            serving_size: brandedInfo.serving_size,
            serving_size_unit: brandedInfo.serving_size_unit,
            household_serving_fulltext: brandedInfo.household_serving_fulltext,
          },
        }
      : null,
    legacyFoodInfo: legacyInfo
      ? {
          fdc_id: legacyInfo.fdc_id,
          ndb_number: legacyInfo.ndb_number,
        }
      : null,
    nutritionInfo,
    portionInfoRaw: portions,
  };
};

import { eq, and, asc, desc, count, sql, isNotNull } from "drizzle-orm";
import { db } from "./client.js";
import * as schema from "./schema.js";
import { toFtsQuery } from "./fts.js";
import type { z } from "zod";
import { nutrient_unit_name } from "@recipehub/usda-schemas";

// Drizzle prepared statements for better performance and type safety
const preparedStatements = {
  // FTS5 queries using Drizzle's sql operator for MATCH queries
  ftsWithDataType: db
    .select({
      fdc_id: schema.foodSearch.fdcId,
      data_type: schema.foodSearch.dataType,
      description: schema.foodSearch.description,
    })
    .from(schema.foodSearch)
    .where(
      and(
        sql`${schema.foodSearch} MATCH ${sql.placeholder("query")}`,
        eq(schema.foodSearch.dataType, sql.placeholder("dataType")),
      ),
    )
    .orderBy(asc(schema.foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsWithDataTypeDesc: db
    .select({
      fdc_id: schema.foodSearch.fdcId,
      data_type: schema.foodSearch.dataType,
      description: schema.foodSearch.description,
    })
    .from(schema.foodSearch)
    .where(
      and(
        sql`${schema.foodSearch} MATCH ${sql.placeholder("query")}`,
        eq(schema.foodSearch.dataType, sql.placeholder("dataType")),
      ),
    )
    .orderBy(desc(schema.foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsCountWithDataType: db
    .select({ count: count() })
    .from(schema.foodSearch)
    .where(
      and(
        sql`${schema.foodSearch} MATCH ${sql.placeholder("query")}`,
        eq(schema.foodSearch.dataType, sql.placeholder("dataType")),
      ),
    )
    .prepare(),

  ftsNoFilter: db
    .select({
      fdc_id: schema.foodSearch.fdcId,
      data_type: schema.foodSearch.dataType,
      description: schema.foodSearch.description,
    })
    .from(schema.foodSearch)
    .where(sql`${schema.foodSearch} MATCH ${sql.placeholder("query")}`)
    .orderBy(asc(schema.foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsNoFilterDesc: db
    .select({
      fdc_id: schema.foodSearch.fdcId,
      data_type: schema.foodSearch.dataType,
      description: schema.foodSearch.description,
    })
    .from(schema.foodSearch)
    .where(sql`${schema.foodSearch} MATCH ${sql.placeholder("query")}`)
    .orderBy(desc(schema.foodSearch.description))
    .limit(sql.placeholder("limit"))
    .offset(sql.placeholder("offset"))
    .prepare(),

  ftsCount: db
    .select({ count: count() })
    .from(schema.foodSearch)
    .where(sql`${schema.foodSearch} MATCH ${sql.placeholder("query")}`)
    .prepare(),

  // Standard table queries using Drizzle query builder
  getFoodByIdStmt: db
    .select({
      fdc_id: schema.usdaFood.fdcId,
      data_type: schema.usdaFood.dataType,
      description: schema.usdaFood.description,
    })
    .from(schema.usdaFood)
    .where(eq(schema.usdaFood.fdcId, sql.placeholder("fdcId")))
    .prepare(),

  getBrandedFoodByIdStmt: db
    .select({
      fdc_id: schema.usdaBrandedFood.fdcId,
      brand_owner: schema.usdaBrandedFood.brandOwner,
      brand_name: schema.usdaBrandedFood.brandName,
      branded_food_category: schema.usdaBrandedFood.brandedFoodCategory,
      gtin_upc: schema.usdaBrandedFood.gtinUpc,
      ingredients: schema.usdaBrandedFood.ingredients,
      serving_size: schema.usdaBrandedFood.servingSize,
      serving_size_unit: schema.usdaBrandedFood.servingSizeUnit,
      household_serving_fulltext:
        schema.usdaBrandedFood.householdServingFulltext,
      modified_date:
        sql<string>`COALESCE(${schema.usdaBrandedFood.modifiedDate}, datetime('now'))`.as(
          "modified_date",
        ),
    })
    .from(schema.usdaBrandedFood)
    .where(eq(schema.usdaBrandedFood.fdcId, sql.placeholder("fdcId")))
    .prepare(),

  getLegacyFoodByIdStmt: db
    .select({
      fdc_id: schema.usdaSrLegacyFood.fdcId,
      ndb_number: schema.usdaSrLegacyFood.ndbNumber,
    })
    .from(schema.usdaSrLegacyFood)
    .where(eq(schema.usdaSrLegacyFood.fdcId, sql.placeholder("fdcId")))
    .prepare(),

  getFoodPortionsStmt: db
    .select({
      amount: schema.usdaFoodPortion.amount,
      modifier: schema.usdaFoodPortion.modifier,
      gram_weight: schema.usdaFoodPortion.gramWeight,
    })
    .from(schema.usdaFoodPortion)
    .where(
      and(
        eq(schema.usdaFoodPortion.fdcId, sql.placeholder("fdcId")),
        isNotNull(schema.usdaFoodPortion.amount),
        isNotNull(schema.usdaFoodPortion.gramWeight),
      ),
    )
    .prepare(),

  getNutrientsStmt: db
    .select({
      amount: schema.usdaFoodNutrient.amount,
      name: schema.usdaNutrient.name,
      unit: schema.usdaNutrient.unitName,
      nutrient_nbr: schema.usdaNutrient.nutrientNbr,
    })
    .from(schema.usdaFoodNutrient)
    .innerJoin(
      schema.usdaNutrient,
      eq(schema.usdaFoodNutrient.nutrientId, schema.usdaNutrient.id),
    )
    .where(eq(schema.usdaFoodNutrient.fdcId, sql.placeholder("fdcId")))
    .prepare(),
};

// 6. Find Food by UPC - returns complete food info
export const findFoodByUpc = (gtinUpc: string) => {
  const result = db
    .select({
      fdc_id: schema.usdaBrandedFood.fdcId,
    })
    .from(schema.usdaBrandedFood)
    .where(eq(schema.usdaBrandedFood.gtinUpc, gtinUpc))
    .get();

  if (!result) return null;

  // Return complete food info for the found FDC ID
  return getCompleteFoodInfo(result.fdc_id);
};

// 7. Find Food by NDB Number - returns complete food info
export const findFoodByNdb = (ndbNumber: number) => {
  const result = db
    .select({
      fdc_id: schema.usdaSrLegacyFood.fdcId,
    })
    .from(schema.usdaSrLegacyFood)
    .where(eq(schema.usdaSrLegacyFood.ndbNumber, ndbNumber))
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
  dataTypeFilter?: string;
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
    conditions.push(eq(schema.usdaFood.dataType, dataTypeFilter));
  }

  const baseQuery = db
    .select({
      fdc_id: schema.usdaFood.fdcId,
      data_type: schema.usdaFood.dataType,
      description: schema.usdaFood.description,
    })
    .from(schema.usdaFood);

  let finalQuery = baseQuery;
  if (conditions.length > 0) {
    finalQuery = finalQuery.where(and(...conditions)) as typeof baseQuery;
  }

  const orderColumn = {
    description: schema.usdaFood.description,
    data_type: schema.usdaFood.dataType,
    fdc_id: schema.usdaFood.fdcId,
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
    portionInfo: {
      raw: portions.filter((p) => p.amount !== null) as Array<{
        amount: number;
        modifier: string | null;
        gram_weight: number;
      }>,
    },
  };
};

import { eq, and, asc, desc, count } from "drizzle-orm";
import { db, sqlite } from "./client.js";
import * as schema from "./schema.js";
import { toFtsQuery } from "./fts.js";
import type { z } from "zod";
import { getNutrientSummaryResponse, nutrient_unit_name } from "../schemas/food.js";

// Prepared statement cache for better performance - now without expensive JOINs!
const preparedStatements = {
  ftsWithDataType: sqlite.prepare(`
    SELECT fdc_id, data_type, description
    FROM food_search
    WHERE food_search MATCH ? AND data_type = ?
    ORDER BY description ASC
    LIMIT ? OFFSET ?;
  `),
  ftsWithDataTypeDesc: sqlite.prepare(`
    SELECT fdc_id, data_type, description
    FROM food_search
    WHERE food_search MATCH ? AND data_type = ?
    ORDER BY description DESC
    LIMIT ? OFFSET ?;
  `),
  ftsCountWithDataType: sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM food_search
    WHERE food_search MATCH ? AND data_type = ?;
  `),
  ftsNoFilter: sqlite.prepare(`
    SELECT fdc_id, data_type, description
    FROM food_search
    WHERE food_search MATCH ?
    ORDER BY description ASC
    LIMIT ? OFFSET ?;
  `),
  ftsNoFilterDesc: sqlite.prepare(`
    SELECT fdc_id, data_type, description
    FROM food_search
    WHERE food_search MATCH ?
    ORDER BY description DESC
    LIMIT ? OFFSET ?;
  `),
  ftsCount: sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM food_search
    WHERE food_search MATCH ?;
  `),
  // Optimized complete food info queries
  getFoodByIdStmt: sqlite.prepare(`
    SELECT fdc_id, data_type, description FROM usda_food WHERE fdc_id = ?;
  `),
  getBrandedFoodByIdStmt: sqlite.prepare(`
    SELECT fdc_id, brand_owner, brand_name, branded_food_category, gtin_upc, ingredients,
           serving_size, serving_size_unit, household_serving_fulltext, 
           COALESCE(modified_date, datetime('now')) as modified_date
    FROM usda_branded_food WHERE fdc_id = ?;
  `),
  getLegacyFoodByIdStmt: sqlite.prepare(`
    SELECT fdc_id, NDB_number as ndb_number FROM usda_sr_legacy_food WHERE fdc_id = ?;
  `),
  getFoodPortionsStmt: sqlite.prepare(`
    SELECT amount, modifier, gram_weight 
    FROM usda_food_portion 
    WHERE fdc_id = ? AND amount IS NOT NULL AND gram_weight IS NOT NULL;
  `),
  getNutrientsStmt: sqlite.prepare(`
    SELECT fn.amount, n.name, n.unit_name as unit, n.nutrient_nbr
    FROM usda_food_nutrient fn
    JOIN usda_nutrient n ON fn.nutrient_id = n.id
    WHERE fn.fdc_id = ?;
  `)
};

export interface FoodBasic {
  fdc_id: number;
  data_type: string;
  description: string | null;
}

export interface LegacyFoodInfo {
  fdc_id: number;
  ndb_number: number;
}

export interface FoodPortion {
  amount: number;
  modifier: string | null;
  gram_weight: number;
}

export interface NutrientSummary {
  amount: number;
  name: string;
  unit: z.infer<typeof nutrient_unit_name>;
}

export interface BrandedFoodInfo {
  fdc_id: number;
  brand_owner: string | null;
  brand_name: string | null;
  branded_food_category: string | null;
  gtin_upc: string;
  ingredients: string | null;
  serving_size: number | null;
  serving_size_unit: string | null;
  household_serving_fulltext: string | null;
  modified_date: string;
}

// 1. Get Food by FDC ID
export const getFoodById = (fdcId: number): FoodBasic | null => {
  const result = db
    .select({
      fdc_id: schema.usdaFood.fdcId,
      data_type: schema.usdaFood.dataType,
      description: schema.usdaFood.description,
    })
    .from(schema.usdaFood)
    .where(eq(schema.usdaFood.fdcId, fdcId))
    .get();

  return result || null;
};

// 2. Get Legacy Food by FDC ID
export const getLegacyFoodById = (fdcId: number): LegacyFoodInfo | null => {
  const result = db
    .select({
      fdc_id: schema.usdaSrLegacyFood.fdcId,
      ndb_number: schema.usdaSrLegacyFood.ndbNumber,
    })
    .from(schema.usdaSrLegacyFood)
    .where(eq(schema.usdaSrLegacyFood.fdcId, fdcId))
    .get();

  return result || null;
};

// 3. Get Food Portions
export const getFoodPortions = (fdcId: number): FoodPortion[] => {
  const results = db
    .select({
      amount: schema.usdaFoodPortion.amount,
      modifier: schema.usdaFoodPortion.modifier,
      gram_weight: schema.usdaFoodPortion.gramWeight,
    })
    .from(schema.usdaFoodPortion)
    .where(eq(schema.usdaFoodPortion.fdcId, fdcId))
    .all();

  return results.filter(
    (r): r is FoodPortion => r.amount !== null && r.gram_weight !== null
  );
};

// 4. Get Nutrient Summary
export const getNutrientSummary = (
  fdcId: number
): z.infer<typeof getNutrientSummaryResponse> => {
  const nutrients = db
    .select({
      amount: schema.usdaFoodNutrient.amount,
      name: schema.usdaNutrient.name,
      unit: schema.usdaNutrient.unitName,
      nutrient_nbr: schema.usdaNutrient.nutrientNbr,
    })
    .from(schema.usdaFoodNutrient)
    .innerJoin(
      schema.usdaNutrient,
      eq(schema.usdaFoodNutrient.nutrientId, schema.usdaNutrient.id)
    )
    .where(eq(schema.usdaFoodNutrient.fdcId, fdcId))
    .all();

  // Find protein (nutrient_nbr 203) and energy (nutrient_nbr 208) for per100 calculations
  const proteinNutrient = nutrients.find((n) => n.nutrient_nbr === "203");
  const energyNutrient = nutrients.find((n) => n.nutrient_nbr === "208");

  return {
    nutrientSummary: nutrients.map((n) => ({
      amount: n.amount,
      name: n.name,
      // Database contains a constrained set of units; cast to the enum type
      unit: n.unit as z.infer<typeof nutrient_unit_name>,
    })),
    nutrientsPer100: {
      protein: proteinNutrient?.amount || 0,
      kcal: energyNutrient?.amount || 0,
    },
  };
};

// 5. Get Branded Food by FDC ID
export const getBrandedFoodById = (fdcId: number): BrandedFoodInfo | null => {
  const result = db
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
      modified_date: schema.usdaBrandedFood.modifiedDate,
    })
    .from(schema.usdaBrandedFood)
    .where(eq(schema.usdaBrandedFood.fdcId, fdcId))
    .get();

  return result
    ? {
        ...result,
        modified_date: result.modified_date || new Date().toISOString(),
      }
    : null;
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
      // With data_type filter: need to join back to main table
      const stmt = direction === "desc" ? preparedStatements.ftsWithDataTypeDesc : preparedStatements.ftsWithDataType;
      const params = [ftsQuery, dataTypeFilter, pageSize, pageIndex * pageSize];
      const countParams = [ftsQuery, dataTypeFilter];

      const rows = stmt.all(...params) as Array<FoodBasic>;
      const totalCount = preparedStatements.ftsCountWithDataType.get(...countParams) as { count: number };

      // Get complete food data for each item
      const completeData = rows.map(row => getCompleteFoodInfo(row.fdc_id)).filter((item): item is NonNullable<typeof item> => item !== null);

      return { data: completeData, count: totalCount?.count ?? 0 };
    } else {
      // Without data_type filter: can use FTS table directly (faster)
      const stmt = direction === "desc" ? preparedStatements.ftsNoFilterDesc : preparedStatements.ftsNoFilter;
      const params = [ftsQuery, pageSize, pageIndex * pageSize];
      const countParams = [ftsQuery];

      const rows = stmt.all(...params) as Array<FoodBasic>;
      const totalCount = preparedStatements.ftsCount.get(...countParams) as { count: number };

      // Get complete food data for each item
      const completeData = rows.map(row => getCompleteFoodInfo(row.fdc_id)).filter((item): item is NonNullable<typeof item> => item !== null);

      return { data: completeData, count: totalCount?.count ?? 0 };
    }
  }

  // No name filter: fall back to indexed exact filters and ordering via drizzle
  const conditions = [] as any[];
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
    direction === "desc" ? desc(orderColumn) : asc(orderColumn)
  ) as typeof baseQuery;

  const data = finalQuery
    .limit(pageSize)
    .offset(pageIndex * pageSize)
    .all();

  // Get complete food data for each item
  const completeData = data.map(row => getCompleteFoodInfo(row.fdc_id)).filter((item): item is NonNullable<typeof item> => item !== null);

  const baseCountQuery = db.select({ count: count() }).from(schema.usdaFood);
  let countQuery = baseCountQuery;
  if (conditions.length > 0) {
    countQuery = countQuery.where(and(...conditions)) as typeof baseCountQuery;
  }
  const totalCount = countQuery.get()?.count ?? 0;

  return { data: completeData, count: totalCount };
};

// Optimized composite query for complete food info - uses prepared statements and faster approach
export const getCompleteFoodInfo = (fdcId: number) => {
  // Get basic food info first
  const foodInfo = preparedStatements.getFoodByIdStmt.get(fdcId) as any;
  if (!foodInfo) return null;

  // Execute all other queries using prepared statements (much faster than individual function calls)
  const brandedInfo = preparedStatements.getBrandedFoodByIdStmt.get(fdcId) as any;
  const legacyInfo = preparedStatements.getLegacyFoodByIdStmt.get(fdcId) as any;
  const portions = preparedStatements.getFoodPortionsStmt.all(fdcId) as any[];
  const nutrients = preparedStatements.getNutrientsStmt.all(fdcId) as any[];

  // Process nutrients for per100 calculations
  const proteinNutrient = nutrients.find((n) => n.nutrient_nbr === "203");
  const energyNutrient = nutrients.find((n) => n.nutrient_nbr === "208");

  const nutritionInfo = {
    nutrientSummary: nutrients.map((n) => ({
      amount: n.amount,
      name: n.name,
      unit: n.unit,
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
    legacyFoodInfo: legacyInfo ? {
      fdc_id: legacyInfo.fdc_id,
      ndb_number: legacyInfo.ndb_number
    } : null,
    nutritionInfo,
    portionInfo: {
      raw: portions,
    },
  };
};

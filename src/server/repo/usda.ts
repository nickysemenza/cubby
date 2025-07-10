import { Prisma, PrismaClient } from "@prisma/client";
import { UnitMapping } from "~/schemas/unitmapping";
import {
  FoodInfo,
  NutrientSummary,
  nutrient_unit_name,
  FoodSummary,
  branded_food_serving_size_unit,
  normalize_branded_food_serving_size_unit,
  NutritionInfo,
  BrandedFoodInfo,
  FoodPortion,
  FoodLookupParam,
  LegacyFoodInfo,
} from "~/schemas/usda";
import { wasm } from "~/hooks/useWasm";
import { type Span, trace } from "@opentelemetry/api";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import {
  formatSearchTerm,
  getSortDirection,
} from "~/server/repo/database-helpers";
import { findProductsByFoodIdentifier } from "./product";

const getFoodByID = async (
  db: PrismaClient,
  fdc_id: number,
): Promise<FoodInfo> => {
  const foodInfo = await db.usda_food.findUniqueOrThrow({
    where: {
      fdc_id: fdc_id,
    },
  });
  return {
    data_type: foodInfo.data_type,
    description: foodInfo.description,
  };
};
const getLegacyFoodByID = async (
  db: PrismaClient,
  fdc_id: number,
): Promise<LegacyFoodInfo | null> => {
  const foodInfo = await db.usda_sr_legacy_food.findFirst({
    where: {
      fdc_id: fdc_id,
    },
  });
  return foodInfo
    ? {
        ndb_number: foodInfo.NDB_number,
      }
    : null;
};

const getFoodPortion = async (
  db: PrismaClient,
  fdc_id: number,
): Promise<FoodPortion[]> => {
  const portions = await db.usda_food_portion.findMany({
    where: {
      fdc_id,
    },
    // include: {
    //   measure_unit: true,
    // },
  });
  // portions.
  return portions.map((p) => {
    return {
      amount: p.amount.toNumber(),
      modifier: p.modifier,
      gram_weight: p.gram_weight.toNumber(),
    };
  });
};
const getNutrientSummary = async (
  db: PrismaClient,
  fdc_id: number,
): Promise<NutritionInfo> => {
  const nutrients = await db.usda_food_nutrient.findMany({
    where: {
      fdc_id,
    },
    include: {
      nutrient: true,
    },
  });

  const nutrientSummary: NutrientSummary[] = nutrients
    .map((n) => {
      const nutrient: NutrientSummary = {
        amount: n.amount.toNumber(),
        name: n.nutrient.name,
        unit: nutrient_unit_name.parse(n.nutrient.unit_name),
      };
      return nutrient;
    })
    .filter((n) => n.amount !== 0);

  return {
    nutrientSummary,
    nutrientsPer100: {
      protein:
        nutrientSummary.find(
          (nutrient) => nutrient.name === "Protein" && nutrient.unit === "G",
        )?.amount || 0,
      kcal:
        nutrientSummary.find(
          (nutrient) => nutrient.name === "Energy" && nutrient.unit === "KCAL",
        )?.amount || 0,
    },
  };
};
const unitMappingFromPortionInfo = (portionInfo: FoodPortion): UnitMapping => {
  const inferredMapping = {
    a: {
      value: portionInfo.amount,
      unit: portionInfo.modifier ?? "portion",
    },
    b: {
      value: portionInfo.gram_weight,
      unit: "g",
    },
    source: "USDA portion",
  };
  return inferredMapping;
};
const getAmountFromBrandedFoodServingSize = (
  w: wasm,
  brandedFood: Prisma.usda_branded_foodGetPayload<object>,
): UnitMapping | undefined => {
  const {
    fdc_id,
    serving_size,
    serving_size_unit,
    household_serving_fulltext,
  } = brandedFood;
  if (
    serving_size === null ||
    serving_size_unit === null ||
    household_serving_fulltext === null
  ) {
    console.log(`branded food ${fdc_id} missing serving info`);
    return undefined;
  }

  const p = w.parse_ingredient(household_serving_fulltext);
  const b = p.amounts.pop();
  if (b === undefined) {
    console.log(`branded food ${fdc_id} missing amounts`);
    return undefined;
  }
  const servingSizeUnit =
    branded_food_serving_size_unit.parse(serving_size_unit);
  const inferredMapping = {
    a: {
      value: serving_size.toNumber(),
      unit: normalize_branded_food_serving_size_unit(servingSizeUnit),
    },
    b,
    source: `USDA FDC ${fdc_id}`,
  };
  return inferredMapping;
};
const brandedFoodDBToAPI = async (
  brandedFood: Prisma.usda_branded_foodGetPayload<object>,
): Promise<BrandedFoodInfo> => {
  const w = await import("recipebridge/pkg");
  return {
    brand_owner: brandedFood.brand_owner,
    brand_name: brandedFood.brand_name,
    branded_food_category: brandedFood.branded_food_category,
    gtin_upc: brandedFood.gtin_upc,
    ingredients: brandedFood.ingredients,
    serving: {
      serving_size: brandedFood.serving_size?.toNumber(),
      serving_size_unit: brandedFood.serving_size_unit,
      household_serving_fulltext: brandedFood.household_serving_fulltext,
    },
    serving_as_amount: getAmountFromBrandedFoodServingSize(w, brandedFood),
  };
};

const getBrandedFoodByID = async (db: PrismaClient, fdc_id: number) => {
  const brandedFood = await db.usda_branded_food.findFirst({
    where: {
      fdc_id,
    },
    orderBy: {
      modified_date: "desc",
    },
  });
  if (brandedFood === null) {
    return null;
  }

  return await brandedFoodDBToAPI(brandedFood);
};

const getBrandedFoodIDByUPC = async (db: PrismaClient, gtin_upc: string) => {
  const brandedFood = await db.usda_branded_food.findFirst({
    where: {
      gtin_upc,
    },
    orderBy: {
      modified_date: "desc",
    },
    select: {
      fdc_id: true,
    },
  });

  return brandedFood?.fdc_id;
};
// Internal helper function for getting legacy food IDs
const getLegacyFoodIDByNDBNumber = async (
  db: PrismaClient,
  ndb_number: number,
) => {
  const food = await db.usda_sr_legacy_food.findUnique({
    where: {
      NDB_number: ndb_number,
    },
  });
  return food?.fdc_id;
};

export const findFood = async (
  db: PrismaClient,
  lookup: FoodLookupParam,
): Promise<FoodSummary | null> => {
  return trace
    .getTracer("repo")
    .startActiveSpan(`findFood`, async (span: Span) => {
      span.setAttributes(lookup);
      const fdc_id =
        lookup.kind === "upc"
          ? await getBrandedFoodIDByUPC(db, lookup.gtin_upc)
          : await getLegacyFoodIDByNDBNumber(db, lookup.ndb_number);
      if (fdc_id === undefined) {
        return null;
      }
      return getFoodSummaryByID(db, fdc_id);
    });
};

export const getFoodSummaryByID = async (
  db: PrismaClient,
  fdc_id: number,
): Promise<FoodSummary | null> => {
  const portionInfoRaw = await getFoodPortion(db, fdc_id);

  // Get branded food info first as we need it for linked products
  const brandedFoodInfo = await getBrandedFoodByID(db, fdc_id);
  const legacyFoodInfo = await getLegacyFoodByID(db, fdc_id);
  const upc = brandedFoodInfo?.gtin_upc;
  // const ndb_number = brandedFoodInfo?.ndb_number;
  // Get linked products
  const linkedProducts = await findProductsByFoodIdentifier(
    db,
    upc !== undefined
      ? { kind: "upc", gtin_upc: upc }
      : legacyFoodInfo !== null
        ? { kind: "ndb", ndb_number: legacyFoodInfo.ndb_number }
        : undefined,
  );

  return {
    fdc_id,
    brandedFoodInfo,
    foodInfo: await getFoodByID(db, fdc_id),
    legacyFoodInfo,
    nutritionInfo: await getNutrientSummary(db, fdc_id),
    portionInfo: {
      raw: portionInfoRaw,
      parsed: portionInfoRaw.map((p) => unitMappingFromPortionInfo(p)),
    },
    linkedProducts,
  };
};

export const listFoods = async (
  db: PrismaClient,
  nameFilter: string | undefined,
  dataTypeFilter: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderBy: Prisma.usda_foodOrderByWithAggregationInput = {
    description: getSortDirection(sort, "description"),
    data_type: getSortDirection(sort, "data_type"),
    fdc_id: getSortDirection(sort, "fdc_id"),
  };

  const where: Prisma.usda_foodWhereInput = {
    // For description, use full-text search with properly formatted query
    description: nameFilter ? formatSearchTerm(nameFilter) : undefined,
    // For data_type, use standard string contains (case insensitive)
    data_type: dataTypeFilter
      ? {
          contains: dataTypeFilter,
          mode: "insensitive",
        }
      : undefined,
  };

  // Define query parameters once to avoid duplication
  const findManyParams = {
    orderBy,
    where,
    ...buildTakeSkip(pagination),
  };

  // Execute both queries in a single transaction for better performance
  const [foods, totalCount] = await db.$transaction([
    db.usda_food.findMany(findManyParams),
    db.usda_food.count({ where }),
  ]);

  // Create simplified food summaries with basic info
  const foodSummaries: FoodSummary[] = await Promise.all(
    foods.map(async (food) => {
      const portionInfoRaw = await getFoodPortion(db, food.fdc_id);

      // Get branded food info for linked products lookup
      const brandedFoodInfo = await getBrandedFoodByID(db, food.fdc_id);

      return {
        fdc_id: food.fdc_id,
        brandedFoodInfo,
        foodInfo: {
          data_type: food.data_type,
          description: food.description,
        },
        nutritionInfo: await getNutrientSummary(db, food.fdc_id),
        portionInfo: {
          raw: portionInfoRaw,
          parsed: portionInfoRaw.map((p) => unitMappingFromPortionInfo(p)),
        },
        linkedProducts: [], // todo?
        legacyFoodInfo: null, // todo?
      };
    }),
  );

  return { data: foodSummaries, count: totalCount };
};

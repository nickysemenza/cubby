import { Prisma, PrismaClient } from "@prisma/client";
import { getIngredientUnit } from "~/app/_components/recipe/utils";
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
} from "~/schemas/usda";
import { wasm } from "~/wasmContext";
import { type Span, trace } from "@opentelemetry/api";

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
const unitMappingFromPortionInfo = (
  w: wasm,
  portionInfo: FoodPortion,
): UnitMapping => {
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
  console.log(`branded food ${fdc_id} parsed household_serving_fulltext`, p);
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
    b: {
      value: b.value,
      unit: getIngredientUnit(b),
    },
    source: `USDA FDC ${fdc_id}`,
  };
  console.log({ inferredMapping });
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
export const getLegacyFoodIDByNDBNumber = async (
  db: PrismaClient,
  ndb_number: number,
) => {
  console.log("getLegacyFoodIDByNDBNumber", ndb_number);
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
  const w = await import("recipebridge/pkg");
  return {
    fdc_id,
    brandedFoodInfo: await getBrandedFoodByID(db, fdc_id),
    foodInfo: await getFoodByID(db, fdc_id),
    nutritionInfo: await getNutrientSummary(db, fdc_id),
    portionInfo: {
      raw: portionInfoRaw,
      parsed: portionInfoRaw.map((p) => unitMappingFromPortionInfo(w, p)),
    },
  };
};

import { PrismaClient } from "@prisma/client";
import {
  FoodInfo,
  NutrientSummary,
  nutrient_unit_name,
  BrandedFoodSummary,
} from "~/schemas/usda";

const getFoodInfo = async (
  db: PrismaClient,
  fdc_id: number,
): Promise<FoodInfo | null> => {
  const foodInfo = await db.usda_food.findFirst({
    where: {
      fdc_id: fdc_id,
    },
  });
  if (foodInfo === null) {
    return null;
  }
  return {
    data_type: foodInfo.data_type,
    description: foodInfo.description,
  };
};

const getNutrientSummary = async (
  db: PrismaClient,
  fdc_id: number,
): Promise<NutrientSummary[]> => {
  const nutrients = await db.usda_food_nutrient.findMany({
    where: {
      fdc_id,
    },
    include: {
      nutrient: true,
    },
  });
  return nutrients.map((food_nutrient_item) => {
    return {
      amount: food_nutrient_item.amount.toNumber(),
      name: food_nutrient_item.nutrient.name,
      unit: nutrient_unit_name.parse(food_nutrient_item.nutrient.unit_name),
    };
  });
};
export const getBrandedFoodSummary = async (
  db: PrismaClient,
  gtin_upc: string,
): Promise<BrandedFoodSummary | null> => {
  const brandedFood = await db.usda_branded_food.findFirst({
    where: {
      gtin_upc,
    },
    orderBy: {
      modified_date: "desc",
    },
  });
  if (brandedFood === null) {
    return null;
  }

  const nutrientSummary: NutrientSummary[] = await getNutrientSummary(
    db,
    brandedFood.fdc_id,
  );
  return {
    fdc_id: brandedFood.fdc_id,
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
    foodInfo: await getFoodInfo(db, brandedFood.fdc_id),
    nutrientSummary,
  };
};

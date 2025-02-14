import { Prisma, PrismaClient } from "@prisma/client";
import { getIngredientUnit } from "~/app/_components/recipe/utils";
import { UnitMapping } from "~/schemas/unitmapping";
import {
  FoodInfo,
  NutrientSummary,
  nutrient_unit_name,
  BrandedFoodSummary,
  branded_food_serving_size_unit,
  normalize_branded_food_serving_size_unit,
} from "~/schemas/usda";
import { wasm } from "~/wasmContext";

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

const calcNutrientsPer100 = (nutrientSummary: NutrientSummary[]) => {
  let protein = 0;
  for (const nutrient of nutrientSummary) {
    if (nutrient.name === "Protein" && nutrient.unit === "G") {
      protein = nutrient.amount;
    }
  }
  return {
    protein,
  };
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
  const pullAmounts = (
    w: wasm,
    brandedFood: Prisma.usda_branded_foodGetPayload<object>,
  ): UnitMapping | undefined => {
    const { serving_size, serving_size_unit, household_serving_fulltext } =
      brandedFood;
    if (
      serving_size === null ||
      serving_size_unit === null ||
      household_serving_fulltext === null
    ) {
      console.log(
        `branded food ${brandedFood.fdc_id} missing serving info`,
        brandedFood,
      );
      return undefined;
    }

    const p = w.parse_ingredient(household_serving_fulltext);
    console.log(
      `branded food ${brandedFood.fdc_id} parsed household_serving_fulltext`,
      p,
    );
    const b = p.amounts.pop();
    if (b === undefined) {
      console.log(
        `branded food ${brandedFood.fdc_id} missing amounts`,
        brandedFood,
      );
      return undefined;
    }
    const servingSizeUnit = branded_food_serving_size_unit.parse(
      brandedFood.serving_size_unit,
    );
    const inferredMapping = {
      a: {
        value: serving_size.toNumber(),
        unit: normalize_branded_food_serving_size_unit(servingSizeUnit),
      },
      b: {
        value: b.value,
        unit: getIngredientUnit(b),
      },
      source: `USDA FDC ${brandedFood.fdc_id}`,
    };
    console.log({ inferredMapping });
    return inferredMapping;
  };

  const nutrientSummary: NutrientSummary[] = await getNutrientSummary(
    db,
    brandedFood.fdc_id,
  );
  const w = await import("recipebridge/pkg");

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
    nutrientsPer100: calcNutrientsPer100(nutrientSummary),
    test123: pullAmounts(w, brandedFood),
  };
};

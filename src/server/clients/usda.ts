import { Prisma, PrismaClient } from "@prisma/client";
import {
  FoodInfo,
  NutrientSummary,
  nutrient_unit_name,
  FoodSummary,
  NutritionInfo,
  BrandedFoodInfo,
  FoodPortion,
  FoodLookupParam,
  LegacyFoodInfo,
} from "~/schemas/usda";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import {
  formatSearchTerm,
  getSortDirection,
} from "~/server/repo/database-helpers";

export class USDAClient {
  constructor(private db: PrismaClient) {}

  private async getFoodByID(fdc_id: number): Promise<FoodInfo> {
    const foodInfo = await this.db.usda_food.findUniqueOrThrow({
      where: {
        fdc_id: fdc_id,
      },
    });
    return {
      data_type: foodInfo.data_type,
      description: foodInfo.description,
    };
  }

  private async getLegacyFoodByID(
    fdc_id: number,
  ): Promise<LegacyFoodInfo | null> {
    const foodInfo = await this.db.usda_sr_legacy_food.findFirst({
      where: {
        fdc_id: fdc_id,
      },
    });
    return foodInfo
      ? {
          ndb_number: foodInfo.NDB_number,
        }
      : null;
  }

  private async getFoodPortion(fdc_id: number): Promise<FoodPortion[]> {
    const portions = await this.db.usda_food_portion.findMany({
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
  }

  private async getNutrientSummary(fdc_id: number): Promise<NutritionInfo> {
    const nutrients = await this.db.usda_food_nutrient.findMany({
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
            (nutrient) =>
              nutrient.name === "Energy" && nutrient.unit === "KCAL",
          )?.amount || 0,
      },
    };
  }

  private async brandedFoodDBToAPI(
    brandedFood: Prisma.usda_branded_foodGetPayload<object>,
  ): Promise<BrandedFoodInfo> {
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
    };
  }

  async getBrandedFoodByID(fdc_id: number) {
    return await this.db.usda_branded_food.findFirst({
      where: {
        fdc_id,
      },
      orderBy: {
        modified_date: "desc",
      },
    });
  }

  private async getBrandedFoodIDByUPC(gtin_upc: string) {
    const brandedFood = await this.db.usda_branded_food.findFirst({
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
  }

  private async getLegacyFoodIDByNDBNumber(ndb_number: number) {
    const food = await this.db.usda_sr_legacy_food.findUnique({
      where: {
        NDB_number: ndb_number,
      },
    });
    return food?.fdc_id;
  }

  async findFood(lookup: FoodLookupParam): Promise<FoodSummary | null> {
    const fdc_id =
      lookup.kind === "upc"
        ? await this.getBrandedFoodIDByUPC(lookup.gtin_upc)
        : await this.getLegacyFoodIDByNDBNumber(lookup.ndb_number);
    if (fdc_id === undefined) {
      return null;
    }
    return this.getFoodSummaryByID(fdc_id);
  }

  async getFoodSummaryByID(fdc_id: number): Promise<FoodSummary | null> {
    const portionInfoRaw = await this.getFoodPortion(fdc_id);

    const brandedFood = await this.getBrandedFoodByID(fdc_id);
    const brandedFoodInfo = brandedFood
      ? await this.brandedFoodDBToAPI(brandedFood)
      : null;
    const legacyFoodInfo = await this.getLegacyFoodByID(fdc_id);

    return {
      fdc_id,
      brandedFoodInfo,
      foodInfo: await this.getFoodByID(fdc_id),
      legacyFoodInfo,
      nutritionInfo: await this.getNutrientSummary(fdc_id),
      portionInfo: {
        raw: portionInfoRaw,
        parsed: [], // To be populated at service layer
      },
    };
  }

  async listFoods(
    nameFilter: string | undefined,
    dataTypeFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ) {
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
    const [foods, totalCount] = await this.db.$transaction([
      this.db.usda_food.findMany(findManyParams),
      this.db.usda_food.count({ where }),
    ]);

    // Create simplified food summaries with basic info
    const foodSummaries: FoodSummary[] = await Promise.all(
      foods.map(async (food) => {
        const portionInfoRaw = await this.getFoodPortion(food.fdc_id);

        const brandedFood = await this.getBrandedFoodByID(food.fdc_id);
        const brandedFoodInfo = brandedFood
          ? await this.brandedFoodDBToAPI(brandedFood)
          : null;

        return {
          fdc_id: food.fdc_id,
          brandedFoodInfo,
          foodInfo: {
            data_type: food.data_type,
            description: food.description,
          },
          nutritionInfo: await this.getNutrientSummary(food.fdc_id),
          portionInfo: {
            raw: portionInfoRaw,
            parsed: [], // To be populated at service layer
          },
          legacyFoodInfo: null, // Not fetched in list view for performance
        };
      }),
    );

    return { data: foodSummaries, count: totalCount };
  }
}

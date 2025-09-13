import {
  FoodSummary,
  BrandedFoodInfo,
  FoodLookupParam,
} from "@recipehub/usda-schemas";
import { type SortParams, type PaginationParams } from "~/schemas/pagination";
import { UsdaApiClient } from "~/usda-api-client/usda-api";
import type { paths } from "~/usda-api-client/usda";

type CompleteFoodResponse =
  paths["/api/foods/{fdc_id}"]["get"]["responses"][200]["content"]["application/json"];

export class USDAClient {
  constructor(private usdaApi: UsdaApiClient) {}

  private transformCompleteFoodToFoodSummary(
    completeFood: CompleteFoodResponse,
  ): FoodSummary {
    // Server now returns data in expected format, just need to add parsed field and handle description null case
    return {
      ...completeFood,
      foodInfo: {
        data_type: completeFood.foodInfo.data_type,
        description: completeFood.foodInfo.description,
      },
      portionInfo: {
        raw: completeFood.portionInfo.raw,
        parsed: [], // To be populated at service layer with WASM processing
      },
    };
  }

  async getBrandedFoodByID(fdc_id: number): Promise<BrandedFoodInfo | null> {
    const { data, error } = await this.usdaApi.getFood(fdc_id.toString());
    if (error || !data || !data.brandedFoodInfo) {
      return null;
    }
    return data.brandedFoodInfo;
  }

  async findFood(lookup: FoodLookupParam): Promise<FoodSummary | null> {
    if (lookup.kind === "upc") {
      const { data, error } = await this.usdaApi.findFoodByUPC(lookup.gtin_upc);
      if (error || !data) {
        return null;
      }
      return this.transformCompleteFoodToFoodSummary(data);
    } else {
      const { data, error } = await this.usdaApi.findFoodByNDB(
        lookup.ndb_number.toString(),
      );
      if (error || !data) {
        return null;
      }
      return this.transformCompleteFoodToFoodSummary(data);
    }
  }

  async getFoodSummaryByID(fdc_id: number): Promise<FoodSummary | null> {
    const { data, error } = await this.usdaApi.getFood(fdc_id.toString());
    if (error || !data) {
      return null;
    }
    return this.transformCompleteFoodToFoodSummary(data);
  }

  async listFoods(
    nameFilter: string | undefined,
    dataTypeFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ) {
    const { data, error } = await this.usdaApi.listFoods({
      nameFilter,
      dataTypeFilter,
      orderBy: sort.orderBy as "description" | "data_type" | "fdc_id",
      direction: sort.direction,
      pageIndex: pagination.pageIndex,
      pageSize: pagination.pageSize,
    });

    if (error || !data) {
      return { data: [], count: 0 };
    }

    // The list endpoint now returns complete food data, so we can transform directly
    const foodSummaries: FoodSummary[] = data.data.map((food) =>
      this.transformCompleteFoodToFoodSummary(food),
    );

    return { data: foodSummaries, count: data.count };
  }
}

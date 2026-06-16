import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import type {
  DataType,
  FoodLookupParam,
  FoodSummary,
} from "@cubby/usda-schemas";
import type { Span } from "@opentelemetry/api";
import { unitMappingsFromFood } from "~/lib/unit-mapping-utils";
import { getTracer, TraceNames } from "~/server/tracing";
import type { USDAClient } from "../clients/usda";

export class USDAService {
  constructor(
    private usdaClient: USDAClient,
    private getLinkedProducts: (
      lookup?: FoodLookupParam,
    ) => Promise<ProductTopLevelOut[]>,
  ) {}

  async findFood(
    lookup: FoodLookupParam,
  ): Promise<FoodSummaryWithLinkedProducts | null> {
    const foodSummary = await getTracer().startActiveSpan(
      TraceNames.service("usda", "findFood"),
      async (span: Span) => {
        span.setAttributes(lookup);
        return await this.usdaClient.findFood(lookup);
      },
    );
    if (!foodSummary) {
      return null;
    }
    return this.enrichWithLinkedProducts(foodSummary);
  }

  async getFoodSummaryByID(
    fdc_id: number,
  ): Promise<FoodSummaryWithLinkedProducts | null> {
    const foodSummary = await this.usdaClient.getFoodSummaryByID(fdc_id);
    if (!foodSummary) {
      return null;
    }
    return this.enrichWithLinkedProducts(foodSummary);
  }

  async listFoods(
    nameFilter: string | undefined,
    dataTypeFilter: DataType | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    foodsOnly?: boolean,
    dataTypes?: DataType[],
  ): Promise<{
    data: FoodSummaryWithLinkedProducts[];
    count: number;
  }> {
    const result = await this.usdaClient.listFoods(
      nameFilter,
      dataTypeFilter,
      sort,
      pagination,
      foodsOnly,
      dataTypes,
    );

    // Load linked products and unit mappings for each food
    const enhancedData: FoodSummaryWithLinkedProducts[] = await Promise.all(
      result.data.map(async (food) => {
        // Get all inferred unit mappings from the food
        const inferredUnitMappings = unitMappingsFromFood(food);

        // Get linked products for this food. Branded products link by barcode
        // (UPC); everything else by the explicit fdc_id (every food has one).
        const upc = food.brandedFoodInfo?.gtin_upc;
        const lookup =
          upc !== undefined
            ? { kind: "upc" as const, gtin_upc: upc }
            : { kind: "fdc" as const, fdc_id: food.fdc_id };

        const linkedProducts = await this.getLinkedProducts(lookup);

        return {
          ...food,
          inferredUnitMappings,
          linkedProducts,
        };
      }),
    );

    return {
      data: enhancedData,
      count: result.count,
    };
  }

  private async enrichWithLinkedProducts(
    foodSummary: FoodSummary,
  ): Promise<FoodSummaryWithLinkedProducts> {
    const upc = foodSummary.brandedFoodInfo?.gtin_upc;

    const linkedProducts: ProductTopLevelOut[] = await this.getLinkedProducts(
      upc !== undefined
        ? { kind: "upc", gtin_upc: upc }
        : { kind: "fdc", fdc_id: foodSummary.fdc_id },
    );

    // Get all inferred unit mappings from the food
    const inferredUnitMappings = unitMappingsFromFood(foodSummary);

    return {
      ...foodSummary,
      inferredUnitMappings,
      linkedProducts,
    };
  }
}

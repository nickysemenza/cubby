import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import type {
  FoodSummaryEnrichment,
  FoodSummaryWithLinkedProducts,
} from "@cubby/schemas/usda";
import type {
  DataType,
  FoodLookupParam,
  FoodSummary,
} from "@cubby/usda-schemas";
import { unitMappingsFromFood } from "~/lib/unit-mapping-utils";
import { TraceNames, withTrace } from "~/server/tracing";
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
    const foodSummary = await withTrace(
      TraceNames.service("usda", "findFood"),
      async (span) => {
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

    // Load linked products + inferred unit mappings for each food (the UPC-first
    // / fdc-fallback enrichment lives in one place — enrichWithLinkedProducts).
    const enhancedData: FoodSummaryWithLinkedProducts[] = await Promise.all(
      result.data.map((food) => this.enrichWithLinkedProducts(food)),
    );

    return {
      data: enhancedData,
      count: result.count,
    };
  }

  async listFoodSummaries(
    nameFilter: string | undefined,
    dataTypeFilter: DataType | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    foodsOnly?: boolean,
    dataTypes?: DataType[],
  ): Promise<{
    data: FoodSummary[];
    count: number;
  }> {
    return await this.usdaClient.listFoods(
      nameFilter,
      dataTypeFilter,
      sort,
      pagination,
      foodsOnly,
      dataTypes,
    );
  }

  async getFoodEnrichmentsByID(
    fdcIds: number[],
  ): Promise<Record<string, FoodSummaryEnrichment>> {
    const uniqueIds = [...new Set(fdcIds)];
    const entries = await Promise.all(
      uniqueIds.map(async (fdcId) => {
        const food = await this.usdaClient.getFoodSummaryByID(fdcId);
        if (!food) return null;
        return [String(fdcId), await this.getFoodEnrichment(food)] as const;
      }),
    );
    return Object.fromEntries(entries.filter((entry) => entry !== null));
  }

  private async enrichWithLinkedProducts(
    foodSummary: FoodSummary,
  ): Promise<FoodSummaryWithLinkedProducts> {
    return {
      ...foodSummary,
      ...(await this.getFoodEnrichment(foodSummary)),
    };
  }

  private async getFoodEnrichment(
    foodSummary: FoodSummary,
  ): Promise<FoodSummaryEnrichment> {
    const upc = foodSummary.brandedFoodInfo?.gtin_upc;

    const linkedProducts: ProductTopLevelOut[] = await this.getLinkedProducts(
      upc !== undefined
        ? { kind: "upc", gtin_upc: upc }
        : { kind: "fdc", fdc_id: foodSummary.fdc_id },
    );

    // Get all inferred unit mappings from the food
    const inferredUnitMappings = unitMappingsFromFood(foodSummary);

    return {
      inferredUnitMappings,
      linkedProducts,
    };
  }
}

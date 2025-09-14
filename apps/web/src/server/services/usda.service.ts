import { type Product } from "@prisma/client";
import { USDAClient } from "../clients/usda";
import {
  type FoodSummary,
  type FoodLookupParam,
} from "@recipehub/usda-schemas";
import { type SortParams, type PaginationParams } from "~/schemas/pagination";
import { unitMappingsFromFood } from "~/schemas/unit-mapping-utils";
import { type FoodSummaryWithLinkedProducts } from "~/schemas/combo";
import { type Span, trace } from "@opentelemetry/api";

export class USDAService {
  constructor(
    private usdaClient: USDAClient,
    private getLinkedProducts: (lookup?: FoodLookupParam) => Promise<Product[]>,
  ) {}

  async findFood(
    lookup: FoodLookupParam,
  ): Promise<FoodSummaryWithLinkedProducts | null> {
    const foodSummary = await trace
      .getTracer("repo")
      .startActiveSpan(`findFood`, async (span: Span) => {
        span.setAttributes(lookup);
        return await this.usdaClient.findFood(lookup);
      });
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
    dataTypeFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ): Promise<{
    data: FoodSummaryWithLinkedProducts[];
    count: number;
  }> {
    const result = await this.usdaClient.listFoods(
      nameFilter,
      dataTypeFilter,
      sort,
      pagination,
    );

    // For list views, we skip linking products for performance but include all unit mappings
    const w = await import("wasm");
    const enhancedData: FoodSummaryWithLinkedProducts[] = result.data.map(
      (food) => {
        // Get all inferred unit mappings from the food
        const inferredUnitMappings = unitMappingsFromFood(food, w);

        return {
          ...food,
          inferredUnitMappings,
          linkedProducts: [], // Skip linked products for performance in list view
        };
      },
    );

    return {
      data: enhancedData,
      count: result.count,
    };
  }

  private async enrichWithLinkedProducts(
    foodSummary: FoodSummary,
  ): Promise<FoodSummaryWithLinkedProducts> {
    const { brandedFoodInfo, legacyFoodInfo } = foodSummary;
    const upc = brandedFoodInfo?.gtin_upc;

    const linkedProducts: Product[] = await this.getLinkedProducts(
      upc !== undefined
        ? { kind: "upc", gtin_upc: upc }
        : legacyFoodInfo !== null
          ? { kind: "ndb", ndb_number: legacyFoodInfo.ndb_number }
          : undefined,
    );

    // Get all inferred unit mappings from the food
    const w = await import("wasm");
    const inferredUnitMappings = unitMappingsFromFood(foodSummary, w);

    return {
      ...foodSummary,
      inferredUnitMappings,
      linkedProducts,
    };
  }
}

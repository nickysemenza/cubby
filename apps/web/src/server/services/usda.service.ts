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
import { uniq } from "es-toolkit";

import { unitMappingsFromFood } from "~/lib/unit-mapping-utils";
import { TraceNames, withTrace } from "~/server/tracing";

import type { USDAClient } from "../clients/usda";

export type USDAServiceClient = Pick<
  USDAClient,
  "findFood" | "findFoodsBatch" | "getFoodSummaryByID" | "listFoods"
>;

const FOOD_DATA_TYPES = new Set<DataType>([
  "branded_food",
  "foundation_food",
  "sr_legacy_food",
  "survey_fndds_food",
]);

export class USDAService {
  constructor(
    private usdaClient: USDAServiceClient,
    private getLinkedProducts: (
      lookup?: FoodLookupParam,
    ) => Promise<ProductTopLevelOut[]>,
    private getLinkedProductLookups?: () => Promise<FoodLookupParam[]>,
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
    linkedProductsOnly?: boolean,
  ): Promise<{
    data: FoodSummaryWithLinkedProducts[];
    count: number;
  }> {
    if (linkedProductsOnly || sort.orderBy === "linkedProducts") {
      return await this.listLinkedProductFoods(
        nameFilter,
        dataTypeFilter,
        sort,
        pagination,
        foodsOnly,
        dataTypes,
      );
    }

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
    linkedProductsOnly?: boolean,
  ): Promise<{
    data: FoodSummary[];
    count: number;
  }> {
    if (linkedProductsOnly || sort.orderBy === "linkedProducts") {
      const result = await this.listLinkedProductFoods(
        nameFilter,
        dataTypeFilter,
        sort,
        pagination,
        foodsOnly,
        dataTypes,
      );
      return {
        data: result.data.map(
          ({
            inferredUnitMappings: _mappings,
            linkedProducts: _products,
            ...food
          }) => food,
        ),
        count: result.count,
      };
    }

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
    const uniqueIds = uniq(fdcIds);
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

  private async listLinkedProductFoods(
    nameFilter: string | undefined,
    dataTypeFilter: DataType | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    foodsOnly?: boolean,
    dataTypes?: DataType[],
  ): Promise<{ data: FoodSummaryWithLinkedProducts[]; count: number }> {
    const lookups = this.getLinkedProductLookups
      ? await this.getLinkedProductLookups()
      : [];
    const foods = await this.usdaClient.findFoodsBatch(lookups);

    const byFdcId = new Map<number, FoodSummary>();
    for (const food of foods) {
      if (food) byFdcId.set(food.fdc_id, food);
    }

    const lowerName = nameFilter?.trim().toLowerCase();
    const dataTypeSet = dataTypes?.length ? new Set(dataTypes) : null;
    const filtered = [...byFdcId.values()].filter((food) => {
      if (
        lowerName &&
        !food.foodInfo.description.toLowerCase().includes(lowerName)
      ) {
        return false;
      }
      if (dataTypeFilter && food.foodInfo.data_type !== dataTypeFilter) {
        return false;
      }
      if (dataTypeSet && !dataTypeSet.has(food.foodInfo.data_type)) {
        return false;
      }
      if (
        foodsOnly &&
        !dataTypeFilter &&
        !dataTypeSet &&
        !FOOD_DATA_TYPES.has(food.foodInfo.data_type)
      ) {
        return false;
      }
      return true;
    });

    const enriched = await Promise.all(
      filtered.map((food) => this.enrichWithLinkedProducts(food)),
    );

    const direction = sort.direction === "asc" ? 1 : -1;
    const sorted = enriched.sort((a, b) => {
      const result =
        sort.orderBy === "linkedProducts"
          ? a.linkedProducts.length - b.linkedProducts.length
          : sort.orderBy === "data_type"
            ? a.foodInfo.data_type.localeCompare(b.foodInfo.data_type)
            : sort.orderBy === "fdc_id"
              ? a.fdc_id - b.fdc_id
              : a.foodInfo.description.localeCompare(b.foodInfo.description);
      return result === 0
        ? a.foodInfo.description.localeCompare(b.foodInfo.description)
        : result * direction;
    });

    const start = pagination.pageIndex * pagination.pageSize;
    return {
      data: sorted.slice(start, start + pagination.pageSize),
      count: sorted.length,
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

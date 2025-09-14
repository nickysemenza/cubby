import { type Product } from "@prisma/client";
import { USDAClient } from "../clients/usda";
import {
  type FoodSummary,
  type FoodLookupParam,
  type BrandedFoodRaw,
  type BrandedFoodServingSizeUnit,
  branded_food_serving_size_unit,
} from "@recipehub/usda-schemas";
import { assertNever } from "~/lib/assert";
import { type SortParams, type PaginationParams } from "~/schemas/pagination";
import {
  unitMappingFromPortionInfo,
  type FoodSummaryWithLinkedProducts,
} from "~/schemas/combo";
import { type UnitMapping } from "~/schemas/unitmapping";
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
  ) {
    const result = await this.usdaClient.listFoods(
      nameFilter,
      dataTypeFilter,
      sort,
      pagination,
    );

    // For list views, we might skip linking products for performance
    // or implement it selectively based on needs
    return result;
  }

  private normalizeBrandedFoodServingSizeUnit(
    unit: BrandedFoodServingSizeUnit,
  ): string {
    switch (unit) {
      case "GM":
      case "GRM":
        return "g";
      case "MC":
      case "MLT":
        return "ml";
      case "g":
      case "IU":
      case "MG":
      case "ml":
        return unit;
      default:
        return assertNever(unit);
    }
  }

  private async getAmountFromBrandedFoodServingSize(
    brandedFood: BrandedFoodRaw,
  ): Promise<UnitMapping | undefined> {
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

    const w = await import("wasm");
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
        value: serving_size,
        unit: this.normalizeBrandedFoodServingSizeUnit(servingSizeUnit),
      },
      b,
      source: `USDA FDC serving`,
      sourceMetadata: { type: "food" as const, fdcId: fdc_id },
    };
    return inferredMapping;
  }

  private async enrichWithLinkedProducts(
    foodSummary: FoodSummary,
  ): Promise<FoodSummaryWithLinkedProducts> {
    const { brandedFoodInfo, legacyFoodInfo, portionInfoRaw, fdc_id } =
      foodSummary;
    const upc = brandedFoodInfo?.gtin_upc;

    const linkedProducts: Product[] = await this.getLinkedProducts(
      upc !== undefined
        ? { kind: "upc", gtin_upc: upc }
        : legacyFoodInfo !== null
          ? { kind: "ndb", ndb_number: legacyFoodInfo.ndb_number }
          : undefined,
    );

    // Calculate enhanced branded food info with serving_as_amount
    let enhancedBrandedFoodInfo = null;
    if (brandedFoodInfo) {
      // Use the branded food info we already have from the complete food response
      const serving_as_amount = await this.getAmountFromBrandedFoodServingSize({
        fdc_id: fdc_id,
        serving_size: brandedFoodInfo.serving.serving_size ?? null,
        serving_size_unit: brandedFoodInfo.serving.serving_size_unit,
        household_serving_fulltext:
          brandedFoodInfo.serving.household_serving_fulltext,
      });

      enhancedBrandedFoodInfo = {
        ...brandedFoodInfo,
        serving_as_amount,
      };
    }

    // Calculate parsed portion info
    const parsedPortionInfo = portionInfoRaw.map((p) =>
      unitMappingFromPortionInfo(p, fdc_id),
    );

    return {
      ...foodSummary,
      brandedFoodInfo: enhancedBrandedFoodInfo,
      portionInfoParsed: parsedPortionInfo,
      linkedProducts,
    };
  }
}

import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { dataTypeLabel } from "@cubby/usda-schemas";
import { Copy, Link2 } from "lucide-react";
import { Row } from "~/components/layout";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { UsdaDataTypeDot } from "~/lib/usda-data-type";
import { nutrientCount } from "~/lib/usda-food-stats";
import { KEY_NUTRIENTS, NutrientsSummary } from "../units/NutrientsSummary";
import { CoreNutrientCoverage } from "./core-nutrient-coverage";

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-muted px-1.5 py-0.5" /* tight: meta chip */
      }
    >
      {children}
    </span>
  );
}

/**
 * Rich dropdown row for a USDA food search result. Renders the full metadata the
 * `usda.list` query already returns — food type, brand, category, serving, UPC/NDB,
 * a linked-product badge, and per-100g nutrition chips — instead of just the name.
 * Every field is omitted gracefully when absent (generic/foundation foods).
 *
 * `duplicateCount` is the number of other UPC-identical records collapsed into
 * this one by the dropdown's dedup, surfaced so nothing feels hidden.
 */
export function UsdaFoodResultRow({
  food,
  duplicateCount = 0,
}: {
  food: FoodSummaryWithLinkedProducts;
  duplicateCount?: number;
}) {
  const { foodInfo, brandedFoodInfo, legacyFoodInfo, nutritionInfo } = food;
  const totalNutrients = nutrientCount(nutritionInfo.nutrientsPer100);

  const brand =
    brandedFoodInfo &&
    !isUnspecifiedManufacturer(
      brandedFoodInfo.brand_name ?? brandedFoodInfo.brand_owner,
    )
      ? (brandedFoodInfo.brand_name ?? brandedFoodInfo.brand_owner)
      : null;

  const serving = brandedFoodInfo?.serving;
  const servingText =
    serving?.household_serving_fulltext ||
    (serving?.serving_size && serving.serving_size_unit
      ? `${serving.serving_size} ${serving.serving_size_unit}`
      : null);

  const linkedCount = food.linkedProducts.length;

  // Mirror NutrientsSummary's whitelist so we only show the "/100g" hint when at
  // least one key nutrient will actually render (foundation/legacy foods often
  // have none).
  const hasNutrition = KEY_NUTRIENTS.some(
    (n) => (nutritionInfo.nutrientsPer100[n.code] ?? 0) > 0,
  );

  return (
    <div className="flex w-full flex-col gap-1">
      <span className="line-clamp-2 font-medium text-sm leading-snug">
        {foodInfo.description}
      </span>

      <Row wrap gap="sm" className="text-muted-foreground text-xs">
        <MetaChip>
          <UsdaDataTypeDot dataType={foodInfo.data_type} />
          {dataTypeLabel(foodInfo.data_type)}
        </MetaChip>
        {brand && <MetaChip>{brand}</MetaChip>}
        {brandedFoodInfo?.branded_food_category && (
          <MetaChip>{brandedFoodInfo.branded_food_category}</MetaChip>
        )}
        {servingText && <MetaChip>{servingText}</MetaChip>}
        {brandedFoodInfo?.gtin_upc && (
          <MetaChip>UPC {brandedFoodInfo.gtin_upc}</MetaChip>
        )}
        {legacyFoodInfo && <MetaChip>NDB {legacyFoodInfo.ndb_number}</MetaChip>}
        {linkedCount > 0 && (
          <MetaChip>
            <Link2 className="h-3 w-3" />
            {linkedCount} linked
          </MetaChip>
        )}
        {duplicateCount > 0 && (
          <MetaChip>
            <Copy className="h-3 w-3" />+{duplicateCount} record
            {duplicateCount === 1 ? "" : "s"}
          </MetaChip>
        )}
      </Row>

      {totalNutrients > 0 && (
        <Row
          align="center"
          wrap
          gap="sm"
          className="text-muted-foreground text-xs"
        >
          <CoreNutrientCoverage nutrients={nutritionInfo.nutrientsPer100} />
          <span>{totalNutrients} nutrients</span>
        </Row>
      )}

      {hasNutrition && (
        <Row
          align="center"
          wrap
          gap="sm"
          className="text-2xs text-muted-foreground"
        >
          <NutrientsSummary nutrients={nutritionInfo.nutrientsPer100} dense />
          <span>/100g</span>
        </Row>
      )}
    </div>
  );
}

import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { dataTypeLabel } from "@cubby/usda-schemas";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";

import { Row } from "~/components/layout";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { servingBasisUnit } from "~/lib/unit-mapping-utils";
import { UsdaDataTypeDot } from "~/lib/usda-data-type";
import { nutrientCount } from "~/lib/usda-food-stats";

import { KEY_NUTRIENTS, NutrientsSummary } from "../units/NutrientsSummary";
import { CoreNutrientCoverage } from "./core-nutrient-coverage";

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 whitespace-nowrap" /* tight: meta chip */
      }
    >
      {children}
    </span>
  );
}

const foodBrand = (
  brandedFoodInfo: FoodSummaryWithLinkedProducts["brandedFoodInfo"],
) => {
  if (!brandedFoodInfo) return null;
  const brand = brandedFoodInfo.brand_name ?? brandedFoodInfo.brand_owner;
  return isUnspecifiedManufacturer(brand) ? null : brand;
};

const foodServingText = (
  brandedFoodInfo: FoodSummaryWithLinkedProducts["brandedFoodInfo"],
) => {
  const serving = brandedFoodInfo?.serving;
  if (serving?.household_serving_fulltext) {
    return serving.household_serving_fulltext;
  }
  if (!serving?.serving_size || !serving.serving_size_unit) return null;
  return `${serving.serving_size} ${serving.serving_size_unit}`;
};

/**
 * Rich dropdown row for a USDA food search result. Renders the full metadata the
 * USDA list projection already returns — food type, brand, category, serving, UPC/NDB,
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

  const brand = foodBrand(brandedFoodInfo);
  const servingText = foodServingText(brandedFoodInfo);

  const linkedCount = food.linkedProducts.length;

  // Mirror NutrientsSummary's whitelist so we only show the "/100g" hint when at
  // least one key nutrient will actually render (foundation/legacy foods often
  // have none).
  const hasNutrition = KEY_NUTRIENTS.some(
    (n) => (nutritionInfo.nutrientsPer100[n.code] ?? 0) > 0,
  );
  const nutrientBasis = servingBasisUnit(food);

  return (
    <div className="flex w-full flex-col gap-1">
      <span className="line-clamp-2 text-sm leading-snug font-medium">
        {foodInfo.description}
      </span>

      <Row wrap gap="sm" className="text-xs text-muted-foreground">
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
            <LinkIcon className="size-3" />
            {linkedCount} linked
          </MetaChip>
        )}
        {duplicateCount > 0 && (
          <MetaChip>
            <CopyIcon className="size-3" />+{duplicateCount} record
            {duplicateCount === 1 ? "" : "s"}
          </MetaChip>
        )}
      </Row>

      {totalNutrients > 0 && (
        <Row
          align="center"
          wrap
          gap="sm"
          className="text-xs text-muted-foreground"
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
          <span>/100{nutrientBasis === "ml" ? "mL" : "g"}</span>
        </Row>
      )}
    </div>
  );
}

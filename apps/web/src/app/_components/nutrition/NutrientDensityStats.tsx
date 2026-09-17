import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  getNutrientValueByKey,
  type NutrientsPer100,
} from "@cubby/usda-schemas";

import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { costPerNutrient, proteinPer100Kcal } from "~/lib/nutrition-intel";
import { safeConvertAmount } from "~/lib/recipe-costing";
import { usdaNutrientBasis } from "~/lib/unit-mapping-utils";
import { formatCurrency } from "~/lib/utils";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "../entity-media/entity-display-images";
import { EntityInlineLink } from "../EntityInlineLink";

/**
 * Basis-units-per-each — the amount a per-each `price` needs to become a
 * per-basis-unit figure, where "basis" matches whatever unit the USDA
 * per-100 nutrient record is stated in ("g", or "ml" for mL-serving branded
 * foods — see `usdaNutrientBasis`). Resolved via the WASM unit-mapping graph
 * (a stored "1 each = X g/ml" product mapping, same as
 * `ProductNutritionLabel`'s `resolveServingBasis`) rather than assumed,
 * because a package's weight/volume is never derivable from the USDA
 * nutrient record alone. Null when no such edge exists in `mappings`.
 */
export function resolveBasisAmountPerEach(
  mappings: UnitMapping[],
  basis: "g" | "ml",
): number | null {
  const result = safeConvertAmount(
    { value: 1, unit: "each" },
    mappings,
    basis === "ml" ? "volume" : "weight",
  );
  if (
    result.isOk() &&
    result.value.unit === basis &&
    Number.isFinite(result.value.value) &&
    result.value.value > 0
  ) {
    return result.value.value;
  }
  return null;
}

export interface NutrientDensityFigures {
  proteinDensity: number | null;
  costPerGramProtein: number | null;
  /** Price exists but the unit-mapping graph has no "1 each = X <basis>" edge yet. */
  needsWeightMapping: boolean;
  /** Which per-each edge is missing: matches the USDA per-100 basis. */
  missingMappingKind: "weight" | "volume";
}

/**
 * Pure composition behind {@link NutrientDensityStats} — split out so the
 * price/weight-basis resolution (the part that can silently regress into a
 * wrong number, or a swallowed omission, rather than the explicit
 * "needs a weight mapping" state) is unit-testable without rendering React.
 */
export function computeNutrientDensityFigures(
  nutrients: NutrientsPer100,
  mappings: UnitMapping[],
  price: number | null,
): NutrientDensityFigures {
  const kcal = getNutrientValueByKey(nutrients, "kcal");
  const protein = getNutrientValueByKey(nutrients, "protein");
  const proteinDensity =
    protein != null && kcal != null ? proteinPer100Kcal(protein, kcal) : null;

  const basis = usdaNutrientBasis(mappings);
  const basisAmountPerEach = resolveBasisAmountPerEach(mappings, basis);
  const proteinGramsPerEach =
    basisAmountPerEach != null && protein != null
      ? (protein * basisAmountPerEach) / 100
      : null;
  const costPerGramProtein =
    price != null ? costPerNutrient(price, proteinGramsPerEach) : null;
  const needsWeightMapping = price != null && basisAmountPerEach == null;
  const missingMappingKind = basis === "ml" ? "volume" : "weight";

  return {
    proteinDensity,
    costPerGramProtein,
    needsWeightMapping,
    missingMappingKind,
  };
}

/**
 * Nutrient-density intel — protein-per-100-kcal (same-basis division, always
 * available once both figures exist) and cost-per-gram-protein (needs the
 * per-each price converted to a per-gram basis first). Shared by product,
 * ingredient, and USDA food detail so "cost per g protein" reads identically
 * everywhere it appears.
 *
 * When a price exists but no weight mapping resolves, that renders as an
 * explicit "needs a weight mapping" nudge rather than silently omitting the
 * figure — a missing mapping is a gap to fill, not a reason to guess.
 */
export function NutrientDensityStats({
  nutrients,
  mappings,
  price,
  mappingProduct,
  canSeeStoredMappings = true,
}: {
  nutrients: NutrientsPer100;
  mappings: UnitMapping[];
  /** Per-each price to convert, or null when nothing is priced (nothing to show). */
  price: number | null;
  /** The product whose weight mapping would resolve the basis — links the
   * "needs a weight mapping" nudge to where a human fixes it. */
  mappingProduct: { id: string; name: string; manufacturer?: string };
  /**
   * Whether `mappings` actually includes the product's STORED unit mappings.
   * False on the USDA food page, whose `linkedProducts` projection has no
   * `unitMappings` field — there, an unresolved basis means "this view cannot
   * see the mappings", not "the product lacks one", so claiming a gap would
   * point a human at a product that may already carry the exact mapping.
   * Suppress the nudge rather than assert something this view cannot know.
   */
  canSeeStoredMappings?: boolean;
}) {
  const displayImages = useEntityDisplayImages([
    { entityType: "product", entityId: mappingProduct.id },
  ]);
  const {
    proteinDensity,
    costPerGramProtein,
    needsWeightMapping,
    missingMappingKind,
  } = computeNutrientDensityFigures(nutrients, mappings, price);

  if (proteinDensity == null && price == null) return null;

  return (
    <Row gap="md" wrap align="baseline">
      {proteinDensity != null && (
        <Description>
          {proteinDensity.toFixed(1)} g protein / 100 kcal
        </Description>
      )}
      {costPerGramProtein != null ? (
        <Description>
          {formatCurrency(costPerGramProtein)} / g protein
        </Description>
      ) : needsWeightMapping && canSeeStoredMappings ? (
        <Description>
          Needs a {missingMappingKind} mapping on{" "}
          <EntityInlineLink
            displayImage={
              displayImages[
                entityDisplayImageKey({
                  entityType: "product",
                  entityId: mappingProduct.id,
                })
              ] ?? null
            }
            entity="product"
            data={mappingProduct}
            compact
          />{" "}
          to price per gram protein
        </Description>
      ) : null}
    </Row>
  );
}

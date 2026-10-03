import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";
import type { ProductNutritionDisplay } from "@cubby/schemas/product";
import {
  isNutrientKey,
  TIER1_NUTRIENTS,
  type NutrientKey,
  type NutritionInfo,
} from "@cubby/usda";

import { roundTo } from "~/lib/number-format";

const EMPTY_MESSAGE =
  "No nutrition on file — link a USDA food or enter the package label.";

const formatAmount = (value: number) => String(roundTo(value, 3));

const nutrientRowLabel = (key: NutrientKey) =>
  `${TIER1_NUTRIENTS[key].displayName} (${TIER1_NUTRIENTS[key].unit.toLowerCase()})`;

/**
 * The one Product nutrition source choice, shared by web and native: a
 * package label leads and supersedes a linked USDA food (the precedence costing
 * already uses in `productWasmInputs`); otherwise USDA per 100 g; otherwise
 * nothing. Label amounts are the stated per-serving figures as printed; an
 * inferred zero is flagged, never shown as a measured one.
 */
export function buildNutritionDisplay(input: {
  labelNutrition: ProductLabelNutrition | null;
  food: { nutritionInfo: NutritionInfo } | null;
}): ProductNutritionDisplay {
  const { labelNutrition: label, food } = input;
  if (label) {
    const measured = Object.entries(label.nutrients).flatMap(([key, value]) =>
      isNutrientKey(key) && value != null ? [{ key, value }] : [],
    );
    measured.sort((a, b) => a.key.localeCompare(b.key));
    const inferredZero = [...new Set(label.inferredZeroNutrients ?? [])]
      .filter((key) => label.nutrients[key] === undefined)
      .sort();
    return {
      source: "label",
      title: "From package label",
      basis: `Per serving · ${formatAmount(label.servingGrams)} g`,
      sourceNote: label.source,
      inferenceEvidence:
        inferredZero.length > 0 ? (label.inferenceEvidence ?? null) : null,
      rows: [
        ...measured.map(({ key, value }) => ({
          key,
          label: nutrientRowLabel(key),
          value: formatAmount(value),
        })),
        ...inferredZero.map((key) => ({
          key,
          label: nutrientRowLabel(key),
          value: "0 · inferred from label",
        })),
      ],
    };
  }
  const info = food?.nutritionInfo;
  const summary = info?.nutrientSummary ?? [];
  if (
    info &&
    (summary.length > 0 || Object.keys(info.nutrientsPer100).length)
  ) {
    return {
      source: "usda",
      title: "From USDA",
      basis: "Per 100 g",
      sourceNote: null,
      inferenceEvidence: null,
      rows: summary.map((nutrient) => ({
        key: nutrient.name,
        label: `${nutrient.name} (${nutrient.unit})`,
        value: formatAmount(nutrient.amount),
      })),
    };
  }
  return {
    source: "none",
    title: EMPTY_MESSAGE,
    basis: "",
    sourceNote: null,
    inferenceEvidence: null,
    rows: [],
  };
}

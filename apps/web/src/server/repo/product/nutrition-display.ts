import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";
import type { ProductNutritionDisplay } from "@cubby/schemas/product";
import {
  isNutrientKey,
  TIER1_NUTRIENT_KEYS,
  TIER1_NUTRIENTS,
  type NutrientKey,
  type NutritionInfo,
} from "@cubby/usda";

import { roundTo } from "~/lib/number-format";

const EMPTY_MESSAGE =
  "No nutrition on file — link a USDA food or enter the package label.";

const roundAmount = (value: number) => roundTo(value, 3);

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
      basis: `Per serving · ${roundAmount(label.servingGrams)} g`,
      sourceNote: label.source,
      inferenceEvidence:
        inferredZero.length > 0 ? (label.inferenceEvidence ?? null) : null,
      rows: [
        ...measured.map(({ key, value }) => ({
          key,
          label: nutrientRowLabel(key),
          amount: roundAmount(value),
          inferred: false,
        })),
        ...inferredZero.map((key) => ({
          key,
          label: nutrientRowLabel(key),
          amount: 0,
          inferred: true,
        })),
      ],
    };
  }
  // The tier-1 per-100 g figures, not `nutrientSummary` (the ~115-row USDA
  // table MCP reads deliberately strip): the same set the web panels show.
  const per100 = food?.nutritionInfo.nutrientsPer100 ?? {};
  const rows = TIER1_NUTRIENT_KEYS.flatMap((key) => {
    const amount = per100[TIER1_NUTRIENTS[key].code];
    return amount == null
      ? []
      : [
          {
            key,
            label: nutrientRowLabel(key),
            amount: roundAmount(amount),
            inferred: false,
          },
        ];
  });
  if (rows.length > 0) {
    return {
      source: "usda",
      title: "From USDA",
      basis: "Per 100 g",
      sourceNote: null,
      inferenceEvidence: null,
      rows,
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

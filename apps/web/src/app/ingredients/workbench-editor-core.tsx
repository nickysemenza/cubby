import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import {
  manualUnitMapping,
  type UnitMapping,
} from "@cubby/schemas/unitmapping";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { FoodSummary } from "@cubby/usda-schemas";

import { getHoverableMeasureUnitIcon } from "~/app/_components/inventory/format-amount";
import { isDisplayMapping } from "~/app/_components/units/unit-mapping-graph";
import { Input } from "~/components/ui/input";
import type { BaseKind } from "~/lib/conversion-coverage";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import {
  getIngredientMappings,
  unitMappingsFromFood,
} from "~/lib/unit-mapping-utils";

// Shared core for the two enrichment surfaces — the dense Browse table editor
// (`WorkbenchEditor`) and the focused Review-queue card — so price parsing,
// product-write shaping, and the unit input can't drift between them.

/** Parse a text input as a positive number, or null if blank/invalid. */
const parsePositive = (raw: string): number | null => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Turn a package-price entry (`$dollars` for `qty unit`) into what a product
 * stores: a scalar per-each price when the unit is `each`, otherwise a money
 * unit mapping (weight/volume ↔ dollar) that bridges the measure to money.
 * Returns both null when no price was entered.
 */
export const buildPackagePrice = (
  dollarsStr: string,
  qtyStr: string,
  unitStr: string,
): PackagePrice => {
  const dollars = parsePositive(dollarsStr);
  if (dollars == null) return { eachPrice: null, mapping: null };
  const qty = parsePositive(qtyStr) ?? 1;
  const unit = unitStr.trim() || "each";
  if (unit.toLowerCase() === "each") {
    return { eachPrice: dollars / qty, mapping: null };
  }
  return {
    eachPrice: null,
    mapping: {
      a: { value: qty, unit },
      b: { value: dollars, unit: "dollar" },
      source: "manual: price (workbench)",
    },
  };
};

interface PackagePrice {
  eachPrice: number | null;
  mapping: UnitMappingInput | null;
}

/** A half-typed conversion row contributing to the live preview. */
interface PreviewConvRow {
  fromQty: string;
  fromUnit: string;
  toQty: string;
  toUnit: string;
}

/**
 * The mapping graph as it *would* be after this edit: the row's current
 * effective edges, plus the USDA food being picked and whatever price/conversion
 * is half-typed. Feeds the live coverage + unit-graph panels so kinds light up
 * as you type, before saving. Shared by the table editor and the review card so
 * the preview is identical on both.
 */
export const buildPreviewMappings = (
  row: EnrichmentRow,
  {
    food,
    dollars,
    qty,
    unit,
    convRows = [],
  }: {
    food: FoodSummaryWithLinkedProducts | null;
    dollars: string;
    qty: string;
    unit: string;
    convRows?: PreviewConvRow[];
  },
): UnitMapping[] => {
  const base: UnitMapping[] = (() => {
    try {
      return getIngredientMappings(row);
    } catch {
      return [];
    }
  })();
  if (food) {
    try {
      base.push(...unitMappingsFromFood(food));
    }
    // SILENT: this is a live preview built from in-progress form input; a
    // food whose data can't synthesize a mapping just contributes nothing
    // to the preview rather than blocking the rest of the editor.
    catch {}
  }
  const d = parsePositive(dollars);
  if (d != null) {
    base.push(
      manualUnitMapping(
        { value: parsePositive(qty) ?? 1, unit: unit.trim() || "each" },
        { value: d, unit: "dollar" },
        "preview",
      ),
    );
  }
  for (const c of convRows) {
    const fq = parsePositive(c.fromQty);
    const tq = parsePositive(c.toQty);
    const fu = c.fromUnit.trim();
    const tu = c.toUnit.trim();
    if (fq != null && tq != null && fu && tu) {
      base.push(
        manualUnitMapping(
          { value: fq, unit: fu },
          { value: tq, unit: tu },
          "preview",
        ),
      );
    }
  }
  return base;
};

/** One editable conversion row in the editors (the user can add several). */
export type ConvRow = {
  id: string;
  fromQty: string;
  fromUnit: string;
  toQty: string;
  toUnit: string;
};
let convRowSeq = 0;
export const blankConvRow = (
  fromUnit = "",
  seed?: { fromValue: number; toValue: number; toUnit: string },
): ConvRow => ({
  id: `c${convRowSeq++}`,
  fromQty: String(seed?.fromValue ?? 1),
  fromUnit,
  toQty: seed ? String(seed.toValue) : "",
  toUnit: seed?.toUnit ?? "g",
});

/** Whether any of the row's products already resolves to a USDA food, or carries a label nutrition override (which supersedes USDA outright). */
export const hasUsdaLink = (row: EnrichmentRow): boolean =>
  row.product.some(
    (p) =>
      p.food != null ||
      p.fdc_id != null ||
      p.primaryGtin != null ||
      p.labelNutrition != null,
  );

/**
 * An ingredient used only in imported cookbook ("book") recipes — i.e. it has
 * recipe usages and every one is book-sourced. Used to hide the cookbook tail
 * from the enrichment worklist. Computed server-side now (the workbench row no
 * longer ships `appearsInRecipes`); see `cookbookOnlyForIngredientSql`.
 */
export const isCookbookOnly = (row: EnrichmentRow): boolean => row.cookbookOnly;

/** The gap-aware analysis that drives which editor inputs a row needs. */
interface GapAnalysis {
  usdaLinked: boolean;
  usdaUnavailable: boolean;
  moneyMissing: boolean;
  /** weight/volume/calories still uncovered. */
  conversionGaps: BaseKind[];
  /** A conversion is the path for those gaps (USDA can't fill them). */
  conversionNeeded: boolean;
  /** A price exists but money is unreachable from a measure. */
  priceIslanded: boolean;
  islandedUnit: string | null;
  /** Effective display conversions already on the row. */
  currentMappings: UnitMapping[];
  /** USDA foods already linked via the row's products. */
  linkedFoods: FoodSummary[];
  /** Formatted "still missing" kinds, e.g. ["weight", "price"]. */
  missingKinds: string[];
  isComplete: boolean;
}

/**
 * Derive what a row still needs, so an editor shows only the inputs that close
 * its actual gaps (link USDA when unlinked, price when money's missing,
 * conversions for measure/calorie gaps). Single source of truth for both the
 * Browse editor and the review card.
 */
export const analyzeGaps = (row: EnrichmentRow): GapAnalysis => {
  const currentMappings = (() => {
    try {
      return getIngredientMappings(row).filter(isDisplayMapping);
    } catch {
      return [];
    }
  })();
  const covered = new Set(row.coverage.covered);
  const applicable = new Set(row.coverage.applicable);
  const usdaLinked = hasUsdaLink(row);
  const usdaUnavailable = row.product.some((p) => p.usdaUnavailable);
  const moneyMissing = applicable.has("money") && !covered.has("money");
  const conversionGaps = (["weight", "volume", "calories"] as const).filter(
    (k) => applicable.has(k) && !covered.has(k),
  );
  const conversionNeeded =
    conversionGaps.length > 0 && (usdaLinked || usdaUnavailable);
  const priceEdge = currentMappings.find(
    (m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit),
  );
  const priceIslanded = moneyMissing && priceEdge != null;
  const islandedUnit = priceEdge
    ? isMoneyUnit(priceEdge.a.unit)
      ? priceEdge.b.unit
      : priceEdge.a.unit
    : null;
  const linkedFoods = row.product
    .map((p) => p.food)
    .filter((f): f is NonNullable<typeof f> => f != null);
  const missingKinds = [
    applicable.has("weight") && !covered.has("weight") && "weight",
    applicable.has("volume") && !covered.has("volume") && "volume",
    moneyMissing && (priceIslanded ? "price (not connected)" : "price"),
    applicable.has("calories") && !covered.has("calories") && "calories",
  ].filter((s): s is string => Boolean(s));
  return {
    usdaLinked,
    usdaUnavailable,
    moneyMissing,
    conversionGaps: [...conversionGaps],
    conversionNeeded,
    priceIslanded,
    islandedUnit,
    currentMappings,
    linkedFoods,
    missingKinds,
    isComplete: row.coverage.tier === "complete",
  };
};

/**
 * Build the per-each price + new unit mappings from a price entry and conversion
 * rows. A half-filled conversion is reported as an error rather than dropped.
 * Shared so both editors produce identical writes.
 */
export const buildPriceAndMappings = ({
  price,
  priceQty,
  priceUnit,
  convRows,
}: {
  price: string;
  priceQty: string;
  priceUnit: string;
  convRows: ConvRow[];
}):
  | { eachPrice: number | null; newMappings: UnitMappingInput[] }
  | { error: string } => {
  const newMappings: UnitMappingInput[] = [];
  const built = buildPackagePrice(price, priceQty, priceUnit);
  if (built.mapping) newMappings.push(built.mapping);

  for (const c of convRows) {
    const fromQty = parsePositive(c.fromQty);
    const toQty = parsePositive(c.toQty);
    const fromUnit = c.fromUnit.trim();
    const toUnit = c.toUnit.trim();
    if (fromQty != null && toQty != null && fromUnit && toUnit) {
      newMappings.push({
        a: { value: fromQty, unit: fromUnit },
        b: { value: toQty, unit: toUnit },
        source: "manual: conversion (workbench)",
      });
    } else if (fromUnit || c.toQty.trim()) {
      return { error: "Fill in both sides of each conversion" };
    }
  }

  return { eachPrice: built.eachPrice, newMappings };
};

/**
 * Whether a price exists on the product (scalar or a money mapping) — used to
 * tell "no price yet" apart from "priced but unreachable" (islanded).
 */
export const hasPriceEntry = (row: EnrichmentRow): boolean =>
  row.product.some(
    (p) =>
      p.pricing.effectivePrice != null ||
      p.unitMappings.some(
        (m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit),
      ),
  );

/** The default price unit for a row: count items price per `each`, the rest per `lb`. */
export const defaultPriceUnit = (row: EnrichmentRow): string =>
  row.priceMode === "per-each" ? "each" : "lb";

/**
 * Shape a product write from a chosen USDA food + price + extra conversions.
 * Bare ingredient → a `create` payload; one with a product → an `update` that
 * appends to (never wipes) the existing mappings. Mirrors `WorkbenchEditor.save`
 * so both surfaces produce identical writes.
 */
type ProductWrite =
  | { kind: "create"; input: ProductCreateInput }
  | {
      kind: "update";
      id: ProductShortcode;
      data: {
        fdc_id?: number;
        price?: number;
        unitMappings?: UnitMappingInput[];
      };
    };

type ProductUpdateData = Extract<ProductWrite, { kind: "update" }>["data"];

export const buildProductWrite = (
  row: EnrichmentRow,
  {
    food,
    eachPrice,
    newMappings,
    productId,
  }: {
    food: FoodSummaryWithLinkedProducts | null;
    eachPrice: number | null;
    newMappings: UnitMappingInput[];
    productId?: string;
  },
): ProductWrite => {
  const product = productId
    ? (row.product.find((candidate) => candidate.id === productId) ?? null)
    : (row.product[0] ?? null);

  if (product == null) {
    return {
      kind: "create",
      input: {
        name: row.name,
        aliases: [],
        tags: [],
        manufacturer: UNSPECIFIED_MANUFACTURER,
        upc: null,
        expectedQuantity: null,
        ingredientId: row.id,
        fdc_id: food?.fdc_id ?? null,
        price: eachPrice,
        unitMappings: newMappings,
        externalIds: [],
      },
    };
  }

  // product.update replaces the whole mapping set — carry the existing rows
  // (with ids) so we append rather than wipe.
  const data: ProductUpdateData = {};
  if (food) data.fdc_id = food.fdc_id;
  if (eachPrice != null) data.price = eachPrice;
  if (newMappings.length > 0) {
    data.unitMappings = [
      ...product.unitMappings.map((m) => ({
        id: m.id,
        a: m.a,
        b: m.b,
        source: m.source,
      })),
      ...newMappings,
    ];
  }
  return { kind: "update", id: product.id, data };
};

/**
 * A unit text input with the shared valid-unit check / measure-kind tooltip
 * adornment (the same `getHoverableMeasureUnitIcon` the amount fields use), so a
 * recognized unit shows a check and hovering reveals its kind. Plain (not RHF-
 * bound) since the workbench editors hold their fields in local state.
 */
export function UnitInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  return (
    <div className="relative w-16">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full pr-6"
      />
      {value.trim() && (
        <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
          {getHoverableMeasureUnitIcon(value.trim())}
        </span>
      )}
    </div>
  );
}

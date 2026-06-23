import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { ProductCreateInput } from "@cubby/schemas/product";
import {
  manualUnitMapping,
  type UnitMapping,
  type UnitMappingInput,
} from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { getHoverableMeasureUnitIcon } from "~/app/_components/inventory/format-amount";
import { Input } from "~/components/ui/input";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import {
  getIngredientMappings,
  unitMappingsFromFood,
} from "~/lib/unit-mapping-utils";
import type { EnrichmentRow } from "~/server/services/ingredient.service";

// Shared core for the two enrichment surfaces — the dense Browse table editor
// (`WorkbenchEditor`) and the focused Review-queue card — so price parsing,
// product-write shaping, and the unit input can't drift between them.

/** Parse a text input as a positive number, or null if blank/invalid. */
export const parsePositive = (raw: string): number | null => {
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
): { eachPrice: number | null; mapping: UnitMappingInput | null } => {
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
    } catch {
      // ignore an un-synthesizable food preview
    }
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

/** Whether any of the row's products already resolves to a USDA food. */
export const hasUsdaLink = (row: EnrichmentRow): boolean =>
  row.product.some((p) => p.food != null || p.fdc_id != null || p.upc != null);

/**
 * Whether a price exists on the product (scalar or a money mapping) — used to
 * tell "no price yet" apart from "priced but unreachable" (islanded).
 */
export const hasPriceEntry = (row: EnrichmentRow): boolean =>
  row.product.some(
    (p) =>
      p.price != null ||
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
      id: ProductId;
      data: {
        fdc_id?: number;
        price?: number;
        unitMappings?: UnitMappingInput[];
      };
    };

export const buildProductWrite = (
  row: EnrichmentRow,
  {
    food,
    eachPrice,
    newMappings,
  }: {
    food: FoodSummaryWithLinkedProducts | null;
    eachPrice: number | null;
    newMappings: UnitMappingInput[];
  },
): ProductWrite => {
  const product = row.product[0] ?? null;

  if (product == null) {
    return {
      kind: "create",
      input: {
        name: row.name,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        upc: null,
        expectedQuantity: null,
        ingredientId: row.id,
        fdc_id: food?.fdc_id ?? null,
        // Ingredient products are food — the synthesized weight/volume/calorie
        // edges come from the fdc link.
        category: "food",
        price: eachPrice,
        unitMappings: newMappings,
        externalIds: [],
      },
    };
  }

  // product.update replaces the whole mapping set — carry the existing rows
  // (with ids) so we append rather than wipe.
  const data: {
    fdc_id?: number;
    price?: number;
    unitMappings?: UnitMappingInput[];
  } = {};
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

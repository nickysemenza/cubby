import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { UnitMapping, UnitMappingInput } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { UnitMappingsTable } from "~/app/_components/units/unitmappingstable";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { BASE_KINDS } from "~/lib/conversion-coverage";
import { queryKeys } from "~/lib/query-keys";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import type { UnitCoverageItem } from "./unit-coverage-items";

// Re-export the pure core (defined in unit-coverage-items.ts so it stays
// unit-testable) so the registry can import everything from one place.
export {
  buildUnitCoverageItems,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-items";

const KIND_LABEL: Record<(typeof BASE_KINDS)[number], string> = {
  weight: "weight",
  volume: "volume",
  money: "price",
  calories: "calories",
};

/**
 * The four base measurement kinds, lit when the graph can already reach them.
 * When `usdaLinked` is provided, also shows a "USDA" chip — so it's clear
 * whether a gap (e.g. calories) is because nothing's linked, or because the
 * linked food simply has no data for that kind.
 */
export function CoverageChips({
  covered,
  usdaLinked,
}: {
  covered: string[];
  usdaLinked?: boolean;
}) {
  const lit = new Set(covered);
  const chip = (key: string, label: string, on: boolean) => (
    <Badge
      key={key}
      variant={on ? "secondary" : "outline"}
      className={on ? undefined : "text-muted-foreground/50"}
    >
      {on && <Check className="mr-1 h-3 w-3" />}
      {label}
    </Badge>
  );
  return (
    <div className="flex flex-wrap gap-1">
      {BASE_KINDS.map((kind) => chip(kind, KIND_LABEL[kind], lit.has(kind)))}
      {usdaLinked !== undefined && chip("usda", "USDA", usdaLinked)}
    </div>
  );
}

/** Parse a text input as a positive number, or null if blank/invalid. */
const parsePositive = (raw: string): number | null => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Like {@link parsePositive} but allows 0 — e.g. a 0-calorie food like salt. */
const parseNonNegative = (raw: string): number | null => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// A comma in a unit breaks the conversion-graph DOT rendering (print_graph
// doesn't escape it), so reject it at entry — a real unit never has one.
const unitHasComma = (u: string) => u.includes(",");

// USDA fills these three; if they're all covered the USDA-link step is moot.
const coversWeightVolumeCalories = (covered: string[]) =>
  ["weight", "volume", "calories"].every((k) => covered.includes(k));

const CORE_4: ReadonlySet<string> = new Set([
  "weight",
  "volume",
  "money",
  "calories",
]);

// A mapping is "core-4 related" if it connects to one of the four base kinds and
// isn't a non-calorie nutrient edge (the USDA nutrition synthesis emits a
// "100 g = N g protein/fat/…" row per tier-1 nutrient — noise for this view).
const isCore4Edge = (m: UnitMapping): boolean => {
  const ka = wasm.amount_kind(m.a);
  const kb = wasm.amount_kind(m.b);
  if (ka.startsWith("nutrient:") || kb.startsWith("nutrient:")) return false;
  return CORE_4.has(ka) || CORE_4.has(kb);
};

/**
 * The product's existing conversions that bear on the core-4 coverage, with
 * their source (USDA portion / nutrition / price / manual) — so it's clear what
 * already covers which kinds before adding more. Loads the product on expand and
 * synthesizes the effective edges (the same set the chips are graded from).
 */
function CurrentCore4Mappings({ productId }: { productId: string }) {
  const api = useTRPC();
  const { data: product } = useQuery(
    api.product.getByID.queryOptions({ id: productId }),
  );
  if (!product) return null;

  let effective: UnitMapping[];
  try {
    effective = getAllUnitMappingsFromProduct(product);
  } catch {
    return null;
  }
  const core4 = effective.filter(isCore4Edge);
  if (core4.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className="font-medium text-xs">Current conversions</p>
      <UnitMappingsTable mappings={core4} />
    </div>
  );
}

/** The inline fix body — variant chosen by the item's kind / ingredient flag. */
export function UnitCoverageInlineFix({
  item,
  close,
}: {
  item: UnitCoverageItem;
  close: () => void;
}) {
  return match(item)
    .with({ kind: "islanded" }, (i) => (
      <DisconnectedFix id={i.id} islands={i.islands} close={close} />
    ))
    .with({ kind: "partial" }, (i) => {
      const cov = i.coverage.covered;
      const has = (k: string) => cov.includes(k);
      // Offer the USDA search only when there's something to find: not linked,
      // not marked unavailable, and weight/volume/calories aren't all covered.
      const showUsda =
        !i.hasUsdaLink &&
        !i.usdaUnavailable &&
        !coversWeightVolumeCalories(cov);
      // Otherwise (already linked, or marked no-USDA) USDA won't fill the gap —
      // so guide manual entry of whatever's still missing.
      return (
        <IngredientFix
          id={i.id}
          name={i.name}
          close={close}
          showUsda={showUsda}
          showManual={!showUsda && !(has("weight") && has("volume"))}
          showCalories={!showUsda && !has("calories")}
          showPrice={!i.hasPrice}
          allowMarkNoUsda={showUsda}
        />
      );
    })
    .with({ kind: "none", isIngredient: true }, (i) => {
      // Truly-empty ingredient: nothing covered, never linked. Offer the USDA
      // search (+ a "no USDA" mark) unless it's already marked unavailable — in
      // which case switch to full manual entry. (A `none` product has no price,
      // so the price step always applies.)
      const showUsda = !i.usdaUnavailable;
      return (
        <IngredientFix
          id={i.id}
          name={i.name}
          close={close}
          showUsda={showUsda}
          showManual={!showUsda}
          showCalories={!showUsda}
          showPrice
          allowMarkNoUsda={showUsda}
        />
      );
    })
    .with({ kind: "none" }, (i) => <PriceFix id={i.id} close={close} />)
    .exhaustive();
}

/** Non-food product: a price is the whole fix. */
function PriceFix({ id, close }: { id: string; close: () => void }) {
  const api = useTRPC();
  const [price, setPrice] = useState("");
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Price saved",
    invalidateKeys: [queryKeys.product.list],
    onSuccess: close,
  });

  const save = () => {
    const value = parsePositive(price);
    if (value == null) {
      toast.error("Enter a price greater than 0");
      return;
    }
    update.mutate({ id, data: { price: value } });
  };

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Not a food — just needs a price.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <span>1 each = $</span>
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="w-24"
        />
        <Button size="sm" onClick={save} disabled={update.isPending}>
          Save price
        </Button>
      </div>
    </div>
  );
}

/**
 * Ingredient missing coverage. Renders only the steps for what's actually
 * missing: the USDA-link step when weight/volume/calories aren't all covered
 * (`showUsda`), and/or the price step when there's no price (`showPrice`).
 * Re-linking an already-linked food or blanking an existing price would be
 * wrong, so the caller derives these from the graded coverage. Lands in one
 * product.update.
 */
function IngredientFix({
  id,
  name,
  close,
  showUsda = true,
  showManual = false,
  showPrice = true,
  showCalories = false,
  allowMarkNoUsda = false,
}: {
  id: string;
  name: string;
  close: () => void;
  showUsda?: boolean;
  /** Offer a free-form "<qty> <unit> = <qty> <unit>" conversion — for gaps the
   * guided steps can't express (a volume the linked food misses; manual entry
   * when there's no USDA food). */
  showManual?: boolean;
  showPrice?: boolean;
  /** Offer a "per 100 g" calorie input — for a food whose USDA record has no
   * calorie data (e.g. salt), or that has no USDA entry. Allows 0. */
  showCalories?: boolean;
  /** Show a "no USDA entry" action that flips the product to manual mode. */
  allowMarkNoUsda?: boolean;
}) {
  const api = useTRPC();
  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(null);
  // Price entry is "<qty> <unit> = $<price>". Defaults to "1 each" (the scalar
  // per-each price), but any measure unit (e.g. "5 lb") becomes a money mapping.
  const [priceQty, setPriceQty] = useState("1");
  const [priceUnit, setPriceUnit] = useState("each");
  const [price, setPrice] = useState("");
  const [kcal, setKcal] = useState("");
  // Free-form conversion "<qty> <unit> = <qty> <unit>" for the residual gaps the
  // guided steps can't express (e.g. a volume the linked food's unit doesn't
  // cover, or connecting an islanded each-price into the weight graph).
  const [cFromQty, setCFromQty] = useState("1");
  const [cFromUnit, setCFromUnit] = useState("");
  const [cToQty, setCToQty] = useState("");
  const [cToUnit, setCToUnit] = useState("g");
  // Existing mappings, so a per-measure price appends rather than replaces them
  // (product.update swaps the whole set). Cached/deduped with CurrentCore4Mappings.
  const { data: product } = useQuery(api.product.getByID.queryOptions({ id }));
  // Also invalidate this product's detail query so the "Current conversions"
  // table (CurrentCore4Mappings reads getByID) reflects the save, not a stale cache.
  const productKey = api.product.getByID.queryKey({ id });
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Coverage updated",
    invalidateKeys: [queryKeys.product.list, productKey],
    onSuccess: close,
  });
  // Marking "no USDA entry" doesn't close the card — it flips this same card into
  // manual-entry mode (the refetched item re-renders the steps).
  const markNoUsda = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Marked: no USDA entry — enter values manually",
    invalidateKeys: [queryKeys.product.list, productKey],
  });

  const save = () => {
    const data: {
      ndb_number?: number;
      upc?: string;
      price?: number;
      unitMappings?: UnitMappingInput[];
    } = {};
    // Per-measure price (e.g. 5 lb = $8) and calories (100 g = N kcal) are unit
    // mappings; collected here and appended to the existing set in one go.
    const newMappings: UnitMappingInput[] = [];

    // Mirror the product form's handleUsdaSelect: prefer the legacy NDB link,
    // fall back to the branded UPC.
    if (showUsda && food) {
      if (food.legacyFoodInfo?.ndb_number != null) {
        data.ndb_number = food.legacyFoodInfo.ndb_number;
      } else if (food.brandedFoodInfo?.gtin_upc) {
        data.upc = food.brandedFoodInfo.gtin_upc;
      } else {
        toast.error("That USDA food has no NDB or UPC to link by");
        return;
      }
    }
    if (showPrice) {
      const dollars = parsePositive(price);
      if (dollars != null) {
        const qty = parsePositive(priceQty) ?? 1;
        const unit = priceUnit.trim() || "each";
        if (unitHasComma(unit)) {
          toast.error("Unit can't contain a comma");
          return;
        }
        if (unit.toLowerCase() === "each") {
          // The per-each price is the product's own scalar field, not a mapping.
          data.price = dollars / qty;
        } else {
          // A per-measure price wires money straight into the weight/volume graph.
          newMappings.push({
            a: { value: qty, unit },
            b: { value: dollars, unit: "dollar" },
            source: "manual: price (problems page)",
          });
        }
      }
    }
    if (showCalories) {
      const k = parseNonNegative(kcal);
      if (k != null) {
        newMappings.push({
          a: { value: 100, unit: "g" },
          b: { value: k, unit: "kcal" },
          source: "manual: calories (problems page)",
        });
      }
    }
    if (showManual) {
      const fromQty = parsePositive(cFromQty);
      const toQty = parsePositive(cToQty);
      const fromUnit = cFromUnit.trim();
      const toUnit = cToUnit.trim();
      if (unitHasComma(fromUnit) || unitHasComma(toUnit)) {
        toast.error("Units can't contain a comma");
        return;
      }
      if (fromQty != null && toQty != null && fromUnit && toUnit) {
        newMappings.push({
          a: { value: fromQty, unit: fromUnit },
          b: { value: toQty, unit: toUnit },
          source: "manual: conversion (problems page)",
        });
      } else if (cFromUnit.trim() || cToQty.trim()) {
        // Partially filled — tell them rather than silently saving nothing.
        toast.error("Fill in both sides of the conversion");
        return;
      }
    }

    if (newMappings.length > 0) {
      // Replace-all: carry the existing rows or they'd be deleted, so refuse
      // until the product has loaded.
      if (!product) {
        toast.error("Couldn't load current conversions — try again");
        return;
      }
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

    if (Object.keys(data).length === 0) {
      toast.error("Fill in a field above to save");
      return;
    }
    update.mutate({ id, data });
  };

  return (
    <div className="space-y-3">
      <CurrentCore4Mappings productId={id} />
      {showUsda && (
        <div className="space-y-1">
          <p className="font-medium text-xs">
            Link a USDA food{" "}
            <span className="font-normal text-muted-foreground">
              — fills weight, volume &amp; calories
            </span>
          </p>
          <UsdaFoodSearchField
            initialQuery={name}
            label=""
            onSelect={setFood}
          />
          {food && (
            <p className="text-positive text-xs">
              Linked: {food.foodInfo.description}
            </p>
          )}
          {allowMarkNoUsda && (
            <button
              type="button"
              className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
              onClick={() =>
                markNoUsda.mutate({ id, data: { usdaUnavailable: true } })
              }
              disabled={markNoUsda.isPending}
            >
              No USDA entry exists — enter values manually
            </button>
          )}
        </div>
      )}
      {showPrice && (
        <div className="space-y-1">
          <p className="font-medium text-xs">Set a price</p>
          <div className="flex items-center gap-1.5 text-sm">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={priceQty}
              onChange={(e) => setPriceQty(e.target.value)}
              className="w-12"
              aria-label="Price quantity"
            />
            <Input
              value={priceUnit}
              onChange={(e) => setPriceUnit(e.target.value)}
              className="w-16"
              aria-label="Price unit"
            />
            <span>= $</span>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-20"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Bulk or generic? Price by measure, e.g. 5 lb = $8.
          </p>
        </div>
      )}
      {showCalories && (
        <div className="space-y-1">
          <p className="font-medium text-xs">
            Set calories{" "}
            <span className="font-normal text-muted-foreground">
              — USDA had none (0 is fine, e.g. salt)
            </span>
          </p>
          <div className="flex items-center gap-1.5 text-sm">
            <span>100 g =</span>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="0"
              value={kcal}
              onChange={(e) => setKcal(e.target.value)}
              className="w-20"
              aria-label="Calories per 100 g"
            />
            <span>kcal</span>
          </div>
        </div>
      )}
      {showManual && (
        <div className="space-y-1">
          <p className="font-medium text-xs">
            Add a conversion{" "}
            <span className="font-normal text-muted-foreground">
              — e.g. 1 cup = 240 g
            </span>
          </p>
          <div className="flex items-center gap-1.5 text-sm">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={cFromQty}
              onChange={(e) => setCFromQty(e.target.value)}
              className="w-12"
              aria-label="From quantity"
            />
            <Input
              value={cFromUnit}
              onChange={(e) => setCFromUnit(e.target.value)}
              placeholder="cup"
              className="w-16"
              aria-label="From unit"
            />
            <span>=</span>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={cToQty}
              onChange={(e) => setCToQty(e.target.value)}
              className="w-14"
              aria-label="To quantity"
            />
            <Input
              value={cToUnit}
              onChange={(e) => setCToUnit(e.target.value)}
              placeholder="g"
              className="w-16"
              aria-label="To unit"
            />
          </div>
        </div>
      )}
      <Button size="sm" onClick={save} disabled={update.isPending}>
        Save
      </Button>
    </div>
  );
}

/**
 * Disconnected mappings: pre-fill N−1 bridge rows chaining each island's
 * representative unit, and append the filled ones to the product's existing
 * mappings.
 */
function DisconnectedFix({
  id,
  islands,
  close,
}: {
  id: string;
  islands: { units: string[]; exampleUnit: string }[];
  close: () => void;
}) {
  const api = useTRPC();
  // One bridge per adjacent island pair connects all N into a single graph.
  const bridges = islands.slice(0, -1).map((isl, i) => ({
    from: isl.exampleUnit,
    to: islands[i + 1]?.exampleUnit ?? "unknown",
  }));
  const [values, setValues] = useState<string[]>(() => bridges.map(() => ""));

  // Load the current mappings so we can resend them — product.update replaces the
  // whole set, so omitting them would silently delete every existing mapping.
  const {
    data: product,
    isLoading,
    isError,
  } = useQuery(api.product.getByID.queryOptions({ id }));
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Conversion saved",
    invalidateKeys: [
      queryKeys.product.list,
      api.product.getByID.queryKey({ id }),
    ],
    onSuccess: close,
  });

  const save = () => {
    const newMappings = bridges.flatMap((b, i) => {
      const value = parsePositive(values[i] ?? "");
      if (value == null) return [];
      return [
        {
          a: { value: 1, unit: b.from },
          b: { value, unit: b.to },
          source: "manual: bridge (problems page)",
        },
      ];
    });
    if (newMappings.length === 0) {
      toast.error("Fill in at least one conversion");
      return;
    }
    // Replace-all merge: carry every existing row (with its id) plus the new
    // bridge(s). If the product hasn't loaded we'd send only the new rows and
    // delete every existing mapping — so refuse to save until it's resolved.
    if (!product) {
      toast.error("Couldn't load current conversions — try again");
      return;
    }
    const existing = product.unitMappings.map((m) => ({
      id: m.id,
      a: m.a,
      b: m.b,
      source: m.source,
    }));
    update.mutate({
      id,
      data: { unitMappings: [...existing, ...newMappings] },
    });
  };

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Add the missing conversion(s) to connect the groups.
      </p>
      {bridges.map((b, i) => (
        <div
          key={`${b.from}-${b.to}`}
          className="flex items-center gap-2 text-sm"
        >
          <span>1 {b.from} =</span>
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder="?"
            value={values[i] ?? ""}
            onChange={(e) =>
              setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))
            }
            className="w-20"
          />
          <span>{b.to}</span>
        </div>
      ))}
      {isError && (
        <p className="text-destructive text-xs">
          Couldn't load this product's current conversions.
        </p>
      )}
      <Button
        size="sm"
        onClick={save}
        disabled={update.isPending || isLoading || !product}
      >
        {isLoading ? "Loading…" : "Save conversion"}
      </Button>
    </div>
  );
}

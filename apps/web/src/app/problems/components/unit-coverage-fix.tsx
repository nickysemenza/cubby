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

/** The four base measurement kinds, lit when the graph can already reach them. */
export function CoverageChips({ covered }: { covered: string[] }) {
  const lit = new Set(covered);
  return (
    <div className="flex flex-wrap gap-1">
      {BASE_KINDS.map((kind) => {
        const on = lit.has(kind);
        return (
          <Badge
            key={kind}
            variant={on ? "secondary" : "outline"}
            className={on ? undefined : "text-muted-foreground/50"}
          >
            {on && <Check className="mr-1 h-3 w-3" />}
            {KIND_LABEL[kind]}
          </Badge>
        );
      })}
    </div>
  );
}

/** Parse a text input as a positive number, or null if blank/invalid. */
const parsePositive = (raw: string): number | null => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

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
    .with({ kind: "partial" }, (i) => (
      <IngredientFix
        id={i.id}
        name={i.name}
        close={close}
        // Only offer to link USDA when it isn't linked yet — re-linking can't
        // fill a gap the linked food doesn't cover.
        showUsda={
          !i.hasUsdaLink && !coversWeightVolumeCalories(i.coverage.covered)
        }
        showPrice={!i.hasPrice}
      />
    ))
    .with({ kind: "none", isIngredient: true }, (i) => (
      <IngredientFix id={i.id} name={i.name} close={close} />
    ))
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
  showPrice = true,
}: {
  id: string;
  name: string;
  close: () => void;
  showUsda?: boolean;
  showPrice?: boolean;
}) {
  const api = useTRPC();
  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(null);
  // Price entry is "<qty> <unit> = $<price>". Defaults to "1 each" (the scalar
  // per-each price), but any measure unit (e.g. "5 lb") becomes a money mapping.
  const [priceQty, setPriceQty] = useState("1");
  const [priceUnit, setPriceUnit] = useState("each");
  const [price, setPrice] = useState("");
  // Existing mappings, so a per-measure price appends rather than replaces them
  // (product.update swaps the whole set). Cached/deduped with CurrentCore4Mappings.
  const { data: product } = useQuery(api.product.getByID.queryOptions({ id }));
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Coverage updated",
    invalidateKeys: [queryKeys.product.list],
    onSuccess: close,
  });
  const bothSteps = showUsda && showPrice;
  // Already linked + priced, but still incomplete (e.g. a USDA portion whose unit
  // isn't recognized). Neither inline step helps — the gap needs a manual
  // conversion, which lives on the product page.
  const noSteps = !showUsda && !showPrice;

  const save = () => {
    const data: {
      ndb_number?: number;
      upc?: string;
      price?: number;
      unitMappings?: UnitMappingInput[];
    } = {};
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
        if (unit.toLowerCase() === "each") {
          // The per-each price is the product's own scalar field, not a mapping.
          data.price = dollars / qty;
        } else {
          // A per-measure price (e.g. 5 lb = $8) is a money mapping — it wires
          // money straight into the weight/volume graph. Replace-all: carry the
          // existing rows or they'd be deleted, so refuse until they've loaded.
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
            {
              a: { value: qty, unit },
              b: { value: dollars, unit: "dollar" },
              source: "manual: price (problems page)",
            },
          ];
        }
      }
    }

    if (Object.keys(data).length === 0) {
      toast.error(
        bothSteps
          ? "Link a USDA food or enter a price"
          : showUsda
            ? "Pick a USDA food"
            : "Enter a price greater than 0",
      );
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
            {bothSteps ? "Step 1 · link USDA" : "Link a USDA food"}{" "}
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
        </div>
      )}
      {showPrice && (
        <div className="space-y-1">
          <p className="font-medium text-xs">
            {bothSteps ? "Step 2 · set price" : "Set a price"}
            {bothSteps && (
              <span className="font-normal text-muted-foreground">
                {" "}
                — USDA can't supply this
              </span>
            )}
          </p>
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
      {noSteps ? (
        <p className="text-muted-foreground text-xs">
          USDA is linked and a price is set — the remaining gap needs a manual
          conversion. Use “Open product” to add one.
        </p>
      ) : (
        <Button size="sm" onClick={save} disabled={update.isPending}>
          Save
        </Button>
      )}
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
    invalidateKeys: [queryKeys.product.list],
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

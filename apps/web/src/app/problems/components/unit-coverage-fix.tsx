import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { BASE_KINDS } from "~/lib/conversion-coverage";
import { queryKeys } from "~/lib/query-keys";
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
      <IngredientFix id={i.id} name={i.name} close={close} />
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
 * Ingredient with no coverage: link a USDA food (synthesizes weight/volume/
 * calories edges live) and set a price (the one kind USDA can't supply). Both
 * land in a single product.update.
 */
function IngredientFix({
  id,
  name,
  close,
}: {
  id: string;
  name: string;
  close: () => void;
}) {
  const api = useTRPC();
  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(null);
  const [price, setPrice] = useState("");
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Coverage updated",
    invalidateKeys: [queryKeys.product.list],
    onSuccess: close,
  });

  const save = () => {
    const data: { ndb_number?: number; upc?: string; price?: number } = {};
    // Mirror the product form's handleUsdaSelect: prefer the legacy NDB link,
    // fall back to the branded UPC.
    if (food) {
      if (food.legacyFoodInfo?.ndb_number != null) {
        data.ndb_number = food.legacyFoodInfo.ndb_number;
      } else if (food.brandedFoodInfo?.gtin_upc) {
        data.upc = food.brandedFoodInfo.gtin_upc;
      } else {
        // A food was picked but it carries neither an NDB number nor a UPC, so
        // there's nothing to link it by — say that, rather than the generic
        // "link a food or set a price" (the "Linked: …" line is showing).
        toast.error("That USDA food has no NDB or UPC to link by");
        return;
      }
    }
    const value = parsePositive(price);
    if (value != null) data.price = value;

    if (Object.keys(data).length === 0) {
      toast.error("Link a USDA food or enter a price");
      return;
    }
    update.mutate({ id, data });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="font-medium text-xs">
          Step 1 · link USDA{" "}
          <span className="font-normal text-muted-foreground">
            — fills weight, volume &amp; calories
          </span>
        </p>
        <UsdaFoodSearchField initialQuery={name} label="" onSelect={setFood} />
        {food && (
          <p className="text-positive text-xs">
            Linked: {food.foodInfo.description}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <p className="font-medium text-xs">
          Step 2 · set price{" "}
          <span className="font-normal text-muted-foreground">
            — USDA can't supply this
          </span>
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
        </div>
      </div>
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

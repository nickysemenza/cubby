import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { UnitMapping, UnitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitMerge,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import { UnitMappingsTable } from "~/app/_components/units/unitmappingstable";
import { CoverageChips } from "~/app/problems/components/unit-coverage-fix";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import {
  getIngredientMappings,
  unitMappingsFromFood,
} from "~/lib/unit-mapping-utils";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";

/** Parse a text input as a positive number, or null if blank/invalid. */
const parsePositive = (raw: string): number | null => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const CORE_4 = new Set(["weight", "volume", "money", "calories"]);

// A mapping bears on the core-4 coverage and isn't a non-calorie nutrient edge
// (USDA synthesis emits a "100 g = N g protein" row per nutrient — noise here).
// Mirrors the Problems page's isCore4Edge so both show the same current set.
const isCore4Edge = (m: UnitMapping): boolean => {
  const ka = wasm.amount_kind(m.a);
  const kb = wasm.amount_kind(m.b);
  if (ka.startsWith("nutrient:") || kb.startsWith("nutrient:")) return false;
  return CORE_4.has(ka) || CORE_4.has(kb);
};

type FilterKey = "all" | "no-product" | "partial" | "no-usda";

/** An AI USDA suggestion for one row, kept at the table level for bulk review. */
type Suggestion = { food: FoodSummaryWithLinkedProducts; reasoning: string };

const FIX_LABEL: Record<EnrichmentRow["recommendedFix"], string> = {
  "no-product": "Link product",
  "link-usda": "Link USDA",
  "set-per-item-price": "Set price",
  "add-purchase-mapping": "Set price",
  "add-weight-mapping": "Add weight",
  done: "Done",
};

const hasUsdaLink = (row: EnrichmentRow): boolean =>
  row.product.some((p) => p.food != null || p.fdc_id != null || p.upc != null);

// True when a price exists on the product (scalar or a money mapping) — used to
// tell "no price yet" apart from "priced but unreachable" (islanded).
const hasPriceEntry = (row: EnrichmentRow): boolean =>
  row.product.some(
    (p) =>
      p.price != null ||
      p.unitMappings.some(
        (m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit),
      ),
  );

// The "Next" badge label. A priced-but-money-uncovered row is islanded — the fix
// is to connect the existing price, not set a new one, so say so.
const fixBadgeLabel = (row: EnrichmentRow): string => {
  if (
    !row.coverage.covered.includes("money") &&
    hasPriceEntry(row) &&
    (row.recommendedFix === "set-per-item-price" ||
      row.recommendedFix === "add-purchase-mapping" ||
      row.recommendedFix === "add-weight-mapping")
  ) {
    return "Connect price";
  }
  return FIX_LABEL[row.recommendedFix];
};

/**
 * Dense bulk-enrichment table for ingredients that can't be fully costed yet —
 * the bare ones EPUB imports leave behind (no product) plus those with a product
 * whose conversion graph is still incomplete. Each row shows its coverage and the
 * single recommended fix, and expands inline to link a USDA food, set a price,
 * and add conversions. Select rows to run AI USDA suggestions and create products
 * in bulk, or mark "no USDA exists" — without the modal-per-ingredient grind.
 */
export function EnrichmentWorkbench() {
  const api = useTRPC();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>(
    {},
  );
  const [mergeSuggestions, setMergeSuggestions] = useState<
    Record<string, { targetId: string; targetName: string }>
  >({});

  const { data, isLoading, error } = useQuery(
    api.ingredient.enrichmentWorkbench.queryOptions(),
  );

  const rows = useMemo(() => data ?? [], [data]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      "no-product": rows.filter((r) => r.recommendedFix === "no-product")
        .length,
      partial: rows.filter((r) => r.recommendedFix !== "no-product").length,
      "no-usda": rows.filter((r) => !hasUsdaLink(r)).length,
    }),
    [rows],
  );

  const visible = useMemo(
    () =>
      match(filter)
        .with("all", () => rows)
        .with("no-product", () =>
          rows.filter((r) => r.recommendedFix === "no-product"),
        )
        .with("partial", () =>
          rows.filter((r) => r.recommendedFix !== "no-product"),
        )
        .with("no-usda", () => rows.filter((r) => !hasUsdaLink(r)))
        .exhaustive(),
    [rows, filter],
  );

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const clearSelection = () => setSelected(new Set());

  const suggestUsda = useMutation(
    api.ai.suggestUsdaFoodBatch.mutationOptions(),
  );
  const createMany = useActionMutation({
    mutationFn: api.product.createMany.mutationOptions,
    success: "Products created.",
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: () => {
      setSuggestions({});
      clearSelection();
    },
    error: (err) => `Create failed: ${getErrorMessage(err)}`,
  });
  const markNoUsda = useActionMutation({
    mutationFn: api.product.markUsdaUnavailableMany.mutationOptions,
    success: "Marked: no USDA entry.",
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: clearSelection,
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const suggestMerges = useMutation(
    api.ai.suggestIngredientMergeBatch.mutationOptions(),
  );
  const mergeMutation = useActionMutation({
    mutationFn: api.ingredient.merge.mutationOptions,
    success: "Merged.",
    invalidateKeys: [["ingredient"]],
    error: (err) => `Merge failed: ${getErrorMessage(err)}`,
  });

  const handleSuggestMerges = async () => {
    const ingredients = selectedRows.map((r) => ({ id: r.id, name: r.name }));
    if (ingredients.length === 0) return;
    try {
      const results = await suggestMerges.mutateAsync({ ingredients });
      const next: Record<string, { targetId: string; targetName: string }> = {};
      let matched = 0;
      for (const r of results) {
        if (r.target) {
          next[r.source.id] = {
            targetId: r.target.id,
            targetName: r.target.name,
          };
          matched++;
        }
      }
      setMergeSuggestions((prev) => ({ ...prev, ...next }));
      toast.success(`AI found ${matched} merge${matched === 1 ? "" : "s"}.`);
    } catch (err) {
      toast.error(`Merge suggestion failed: ${getErrorMessage(err)}`);
    }
  };

  const handleMerge = (sourceId: string, targetId: string) => {
    mergeMutation.mutate({ target: targetId, aliases: [sourceId] });
    setMergeSuggestions((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
  };

  const handleSuggest = async () => {
    const names = selectedRows.map((r) => r.name);
    if (names.length === 0) return;
    const byName = new Map(
      selectedRows.map((r) => [r.name.toLowerCase(), r.id]),
    );
    try {
      const results = await suggestUsda.mutateAsync({ ingredientNames: names });
      const next: Record<string, Suggestion> = {};
      let matched = 0;
      for (const r of results) {
        const id = byName.get(r.name.toLowerCase());
        if (id && r.food) {
          next[id] = { food: r.food, reasoning: r.reasoning };
          matched++;
        }
      }
      setSuggestions((prev) => ({ ...prev, ...next }));
      toast.success(`AI matched ${matched}/${names.length}.`);
    } catch (err) {
      toast.error(`Suggestion failed: ${getErrorMessage(err)}`);
    }
  };

  const creatable = selectedRows.filter(
    (r) => r.product.length === 0 && suggestions[r.id],
  );
  const handleCreate = () => {
    if (creatable.length === 0) {
      toast.error("No selected rows have an AI suggestion yet. Suggest first.");
      return;
    }
    createMany.mutate(
      creatable.map((r) => ({
        name: r.name,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        upc: null,
        expectedQuantity: null,
        ingredientId: r.id,
        fdc_id: suggestions[r.id]!.food.fdc_id,
        price: null,
        unitMappings: [],
      })),
    );
  };

  const markable = selectedRows.flatMap((r) =>
    r.product.length > 0 && !hasUsdaLink(r) ? [r.product[0]!.id] : [],
  );
  const handleMarkNoUsda = () => {
    if (markable.length === 0) {
      toast.error("No selected rows have a product missing a USDA link.");
      return;
    }
    markNoUsda.mutate({ ids: markable });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ["all", "All"],
            ["no-product", "No product"],
            ["partial", "Partial"],
            ["no-usda", "No USDA"],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm transition-colors",
              filter === key
                ? "bg-secondary font-medium"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {label} {counts[key]}
          </button>
        ))}
      </div>

      {error && <div className="text-destructive text-sm">{error.message}</div>}

      {!isLoading && rows.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm">
          Every recipe ingredient is fully costable. Nothing to enrich.
        </div>
      )}

      {visible.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-2xs text-muted-foreground uppercase tracking-wide">
                <th className="w-8 px-2 py-2" />
                <th className="w-8 px-2 py-2" />
                <th className="px-2 py-2 font-medium">Ingredient</th>
                <th className="px-2 py-2 font-medium">Coverage</th>
                <th className="px-2 py-2 font-medium">Next</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <WorkbenchRow
                  key={row.id}
                  row={row}
                  selected={selected.has(row.id)}
                  onToggle={() => toggle(row.id)}
                  suggestion={suggestions[row.id] ?? null}
                  mergeSuggestion={mergeSuggestions[row.id] ?? null}
                  onMerge={handleMerge}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isLoading && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {selected.size > 0 && (
        <div className="sticky bottom-4 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 px-4 py-2.5 shadow-sm backdrop-blur">
          <span className="font-medium text-sm">{selected.size} selected</span>
          <span className="text-border">|</span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSuggest}
            disabled={suggestUsda.isPending}
          >
            <Sparkles className="h-4 w-4" />
            {suggestUsda.isPending ? "Suggesting…" : "Suggest USDA"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSuggestMerges}
            disabled={suggestMerges.isPending}
          >
            <Sparkles className="h-4 w-4" />
            {suggestMerges.isPending ? "Checking…" : "Suggest merges"}
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createMany.isPending || creatable.length === 0}
          >
            Create {creatable.length} product{creatable.length === 1 ? "" : "s"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleMarkNoUsda}
            disabled={markNoUsda.isPending || markable.length === 0}
          >
            Mark no-USDA ({markable.length})
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function WorkbenchRow({
  row,
  selected,
  onToggle,
  suggestion,
  mergeSuggestion,
  onMerge,
}: {
  row: EnrichmentRow;
  selected: boolean;
  onToggle: () => void;
  suggestion: Suggestion | null;
  mergeSuggestion: { targetId: string; targetName: string } | null;
  onMerge: (sourceId: string, targetId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr
        className={cn(
          "cursor-pointer border-b transition-colors hover:bg-accent/40",
          (open || selected) && "bg-accent/30",
        )}
        onClick={(e) => {
          // Don't toggle the row when the click came from the checkbox, the
          // merge button, or any other interactive control inside it.
          if (
            (e.target as HTMLElement).closest(
              'button, input, a, [role="checkbox"]',
            )
          ) {
            return;
          }
          setOpen((v) => !v);
        }}
      >
        <td className="px-2 py-2.5">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label={`Select ${row.name}`}
          />
        </td>
        <td className="px-2 py-2.5 text-muted-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </td>
        <td className="px-2 py-2.5">
          <div className="font-medium">{row.name}</div>
          <div className="text-muted-foreground text-xs">
            × {row.recipeCount} recipe{row.recipeCount === 1 ? "" : "s"}
            {suggestion && (
              <span className="ml-1.5 text-info">
                · AI: {suggestion.food.foodInfo.description}
              </span>
            )}
          </div>
          {mergeSuggestion && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-info text-xs">
                ≈ {mergeSuggestion.targetName}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onMerge(row.id, mergeSuggestion.targetId);
                }}
              >
                <GitMerge className="h-3 w-3" />
                Merge
              </Button>
            </div>
          )}
        </td>
        <td className="px-2 py-2.5">
          <CoverageChips covered={row.coverage.covered} />
        </td>
        <td className="px-2 py-2.5">
          <Badge variant="outline" className="font-normal">
            {fixBadgeLabel(row)}
          </Badge>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/20">
          <td />
          <td />
          <td colSpan={3} className="px-2 py-3 pr-4">
            <WorkbenchEditor
              row={row}
              initialFood={suggestion?.food ?? null}
              onDone={() => setOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Unified inline editor. For a bare ingredient it creates the first product; for
 * one with a product it updates the first one. Either way: link a USDA food
 * (fills weight/volume/calories), set a price ("<qty> <unit> = $<price>": `each`
 * → the scalar per-each price, a measure like 2 lb → a money unit mapping so
 * weight/volume recipe lines stay costable), and optionally add one conversion.
 * Works off the row's already-loaded products, so updates merge with existing
 * mappings without a refetch.
 */
function WorkbenchEditor({
  row,
  initialFood,
  onDone,
}: {
  row: EnrichmentRow;
  initialFood: FoodSummaryWithLinkedProducts | null;
  onDone: () => void;
}) {
  const api = useTRPC();
  const product = row.product[0] ?? null;
  const usdaLinked = hasUsdaLink(row);

  // Current state shown before the inputs (same as the Problems inline fix):
  // the linked USDA food(s) and the effective core-4 conversions, derived from
  // the row's already-loaded products — no refetch.
  const linkedFoods = row.product
    .map((p) => p.food)
    .filter((f): f is NonNullable<typeof f> => f != null);
  const currentMappings = useMemo<UnitMapping[]>(() => {
    try {
      return getIngredientMappings(row).filter(isCore4Edge);
    } catch {
      return [];
    }
  }, [row]);

  // Which base kinds are still uncovered, so the steps reflect what each fix
  // actually closes: price closes money; a conversion closes a measure/calorie
  // gap. The conversion is only "optional" once nothing measurable is missing —
  // setting a price won't cover volume, so don't pretend it's optional then.
  const covered = new Set(row.coverage.covered);
  const moneyMissing = !covered.has("money");
  const usdaUnavailable = row.product.some((p) => p.usdaUnavailable);
  const conversionGaps = (["weight", "volume", "calories"] as const).filter(
    (k) => !covered.has(k),
  );
  // A conversion is the path for those gaps only once USDA can't fill them
  // (already linked, or there's no USDA entry). Before that, linking USDA is.
  const conversionNeeded =
    conversionGaps.length > 0 && (usdaLinked || usdaUnavailable);

  // Islanded price: a price exists but money is unreachable from a measure (e.g.
  // a per-each price on a food whose portions only map "large"/"cup" → g, never
  // "each" → g). The fix is to *connect* the existing price, not add a new one —
  // bridge its measure-side unit into the weight graph (`1 each = N g`).
  const priceEdge = currentMappings.find(
    (m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit),
  );
  const priceIslanded = moneyMissing && priceEdge != null;
  const islandedUnit = priceEdge
    ? isMoneyUnit(priceEdge.a.unit)
      ? priceEdge.b.unit
      : priceEdge.a.unit
    : null;

  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(
    initialFood,
  );
  const [priceQty, setPriceQty] = useState("1");
  const [priceUnit, setPriceUnit] = useState(
    row.priceMode === "per-each" ? "each" : "lb",
  );
  const [price, setPrice] = useState("");
  // Pre-seed the conversion to bridge an islanded price into grams.
  const [cFromQty, setCFromQty] = useState("1");
  const [cFromUnit, setCFromUnit] = useState(islandedUnit ?? "");
  const [cToQty, setCToQty] = useState("");
  const [cToUnit, setCToUnit] = useState("g");

  // The mapping graph as it *would* be after this edit: the product's current
  // effective edges, plus the USDA food being picked and whatever price/
  // conversion is half-typed. Feeds the live coverage panel so kinds light up as
  // you type, before saving.
  const previewMappings = useMemo<UnitMapping[]>(() => {
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
    const dollars = parsePositive(price);
    if (dollars != null) {
      base.push({
        a: {
          value: parsePositive(priceQty) ?? 1,
          unit: priceUnit.trim() || "each",
        },
        b: { value: dollars, unit: "dollar" },
        source: "preview",
        sourceMetadata: { type: "manual" },
      });
    }
    const fq = parsePositive(cFromQty);
    const tq = parsePositive(cToQty);
    const fu = cFromUnit.trim();
    const tu = cToUnit.trim();
    if (fq != null && tq != null && fu && tu) {
      base.push({
        a: { value: fq, unit: fu },
        b: { value: tq, unit: tu },
        source: "preview",
        sourceMetadata: { type: "manual" },
      });
    }
    return base;
  }, [
    row,
    food,
    price,
    priceQty,
    priceUnit,
    cFromQty,
    cToQty,
    cFromUnit,
    cToUnit,
  ]);

  const createProduct = useActionMutation({
    mutationFn: api.product.create.mutationOptions,
    success: `Enriched ${row.name}.`,
    invalidateKeys: [["ingredient"]],
    onSuccess: onDone,
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });
  const updateProduct = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    success: `Updated ${row.name}.`,
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: onDone,
    error: (err) => `Failed to update: ${getErrorMessage(err)}`,
  });

  const buildPriceAndMappings = () => {
    let eachPrice: number | null = null;
    const newMappings: UnitMappingInput[] = [];

    const dollars = parsePositive(price);
    if (dollars != null) {
      const qty = parsePositive(priceQty) ?? 1;
      const unit = priceUnit.trim() || "each";
      if (unit.toLowerCase() === "each") {
        eachPrice = dollars / qty;
      } else {
        newMappings.push({
          a: { value: qty, unit },
          b: { value: dollars, unit: "dollar" },
          source: "manual: price (workbench)",
        });
      }
    }

    const fromQty = parsePositive(cFromQty);
    const toQty = parsePositive(cToQty);
    const fromUnit = cFromUnit.trim();
    const toUnit = cToUnit.trim();
    if (fromQty != null && toQty != null && fromUnit && toUnit) {
      newMappings.push({
        a: { value: fromQty, unit: fromUnit },
        b: { value: toQty, unit: toUnit },
        source: "manual: conversion (workbench)",
      });
    } else if (
      (cFromUnit.trim() || cToQty.trim()) &&
      newMappings.length === 0
    ) {
      return { error: "Fill in both sides of the conversion" as const };
    }

    return { eachPrice, newMappings };
  };

  const save = () => {
    const built = buildPriceAndMappings();
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    const { eachPrice, newMappings } = built;

    if (food == null && eachPrice == null && newMappings.length === 0) {
      toast.error("Link a USDA food, set a price, or add a conversion first");
      return;
    }

    if (product == null) {
      createProduct.mutate({
        name: row.name,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        upc: null,
        expectedQuantity: null,
        ingredientId: row.id,
        fdc_id: food?.fdc_id ?? null,
        price: eachPrice,
        unitMappings: newMappings,
      });
      return;
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
    updateProduct.mutate({ id: product.id, data });
  };

  const isPending = createProduct.isPending || updateProduct.isPending;

  return (
    <div className="space-y-3">
      {product && (linkedFoods.length > 0 || currentMappings.length > 0) && (
        <div className="max-w-2xl space-y-2 rounded-md border bg-background/60 p-2">
          {linkedFoods.length > 0 && (
            <p className="flex items-center gap-1 text-xs">
              <Check className="h-3 w-3 text-positive" />
              <span className="text-muted-foreground">Linked USDA:</span>{" "}
              {linkedFoods.map((f) => f.foodInfo.description).join(", ")}
            </p>
          )}
          {currentMappings.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-xs">Current conversions</p>
              <UnitMappingsTable mappings={currentMappings} />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex-1 space-y-3 lg:max-w-md">
          {product && row.coverage.tier !== "complete" && (
            <p className="text-xs">
              <span className="font-medium text-warning">Still missing:</span>{" "}
              {[
                !covered.has("weight") && "weight",
                !covered.has("volume") && "volume",
                moneyMissing &&
                  (priceIslanded ? "price (not connected)" : "price"),
                !covered.has("calories") && "calories",
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}

          {!usdaLinked && (
            <div className="space-y-1">
              <p className="font-medium text-xs">
                Link a USDA food{" "}
                <span className="font-normal text-muted-foreground">
                  — fills weight, volume &amp; calories
                </span>
              </p>
              <UsdaFoodSearchField
                initialQuery={row.name}
                label=""
                onSelect={setFood}
              />
              {food && (
                <p className="flex items-center gap-1 text-positive text-xs">
                  <Check className="h-3 w-3" />
                  {food.foodInfo.description}
                </p>
              )}
            </div>
          )}

          {priceIslanded && (
            <p className="rounded-md border bg-warning/10 px-2 py-1.5 text-warning text-xs">
              Already priced, but “{islandedUnit}” isn’t linked to a weight — so
              the price can’t be reached from a recipe measure. Connect it below
              (e.g. 1 {islandedUnit} = N&nbsp;g) instead of adding a new price.
            </p>
          )}

          {moneyMissing && !priceIslanded && (
            <div className="space-y-1">
              <p className="font-medium text-xs">Set a price</p>
              <div className="flex items-center gap-1.5 text-sm">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
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
                For foods, price by the package, e.g. 2&nbsp;lb = $5.99. Use
                “each” for count items.
              </p>
            </div>
          )}

          <div className="space-y-1">
            <p className="font-medium text-xs">
              {priceIslanded ? "Connect the price" : "Add a conversion"}{" "}
              <span className="font-normal text-muted-foreground">
                {priceIslanded
                  ? `— links “${islandedUnit}” to grams so your price is reachable`
                  : conversionNeeded
                    ? `— covers ${conversionGaps.join(", ")} (e.g. 1 cup = 240 g)`
                    : "— optional, e.g. 1 cup = 240 g"}
              </span>
            </p>
            <div className="flex items-center gap-1.5 text-sm">
              <Input
                type="number"
                inputMode="decimal"
                min="0"
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

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={isPending}>
              {isPending
                ? "Saving…"
                : product == null
                  ? "Create product"
                  : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </div>

        <div className="shrink-0 space-y-1 lg:w-64">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Coverage (live)
          </p>
          <div className="rounded-md border bg-background/60 p-2">
            <ConversionCapabilities
              mappings={previewMappings}
              hideConvertButton
            />
          </div>
          <p className="text-[10px] text-muted-foreground leading-tight">
            Updates as you type. Each tile is a convertible pair of base kinds.
          </p>
        </div>
      </div>
    </div>
  );
}

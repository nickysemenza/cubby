import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { Check, ChevronDown, ChevronRight, Package } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";

/** Parse a text input as a positive number, or null if blank/invalid. */
const parsePositive = (raw: string): number | null => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Dense bulk-enrichment table for the bare ingredients that EPUB imports leave
 * behind (no linked product → can't be costed). Replaces the old modal-per-
 * ingredient EnrichmentQueue: each row expands inline to link a USDA food, set a
 * price, and add conversions in one `product.create`, without leaving the page.
 *
 * Phase 1 scopes to the no-product backlog; coverage chips, partial-coverage
 * rows, merge suggestions, and bulk/AI actions land in later phases.
 */
export function EnrichmentWorkbench() {
  const api = useTRPC();
  const { data, isLoading, error } = useQuery(
    api.ingredient.list.queryOptions({
      filters: { missingProductsOnly: true },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
  );

  const items = data?.items ?? [];
  const total = data?.meta.totalCount ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {isLoading
          ? "Loading…"
          : `${total} ingredient${total === 1 ? "" : "s"} need a product before they can be costed.`}
      </p>

      {error && <div className="text-destructive text-sm">{error.message}</div>}

      {!isLoading && items.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm">
          Every ingredient is linked to a product. Nothing to enrich.
        </div>
      )}

      {items.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-2xs text-muted-foreground uppercase tracking-wide">
                <th className="w-8 px-2 py-2" />
                <th className="px-2 py-2 font-medium">Ingredient</th>
                <th className="px-2 py-2 font-medium">Next</th>
              </tr>
            </thead>
            <tbody>
              {items.map((ingredient) => (
                <WorkbenchRow key={ingredient.id} ingredient={ingredient} />
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
    </div>
  );
}

function WorkbenchRow({ ingredient }: { ingredient: IngredientWithFoodOut }) {
  const [open, setOpen] = useState(false);
  const recipeCount = uniq(ingredient.appearsInRecipes.map((r) => r.id)).length;

  return (
    <>
      <tr
        className={cn(
          "cursor-pointer border-b transition-colors hover:bg-accent/40",
          open && "bg-accent/30",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-2 py-2.5 text-muted-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </td>
        <td className="px-2 py-2.5">
          <div className="font-medium">{ingredient.name}</div>
          <div className="text-muted-foreground text-xs">
            × {recipeCount} recipe{recipeCount === 1 ? "" : "s"}
          </div>
        </td>
        <td className="px-2 py-2.5">
          <Badge variant="outline" className="gap-1 font-normal">
            <Package className="h-3 w-3" />
            Link product
          </Badge>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/20">
          <td />
          <td colSpan={2} className="px-2 py-3 pr-4">
            <EnrichInlineForm
              ingredientId={ingredient.id}
              ingredientName={ingredient.name}
              onDone={() => setOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Inline "create the first product" editor. Mirrors the Problems-page
 * IngredientFix steps (USDA link → price → optional conversion) but lands in a
 * single `product.create` for a bare ingredient. The price is "<qty> <unit> =
 * $<price>": `each` writes the scalar per-each price, any measure (e.g. 2 lb)
 * becomes a money unit mapping so weight/volume recipe lines can be costed.
 */
function EnrichInlineForm({
  ingredientId,
  ingredientName,
  onDone,
}: {
  ingredientId: IngredientWithFoodOut["id"];
  ingredientName: string;
  onDone: () => void;
}) {
  const api = useTRPC();
  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(null);
  const [priceQty, setPriceQty] = useState("1");
  const [priceUnit, setPriceUnit] = useState("each");
  const [price, setPrice] = useState("");

  const createProduct = useActionMutation({
    mutationFn: api.product.create.mutationOptions,
    success: `Enriched ${ingredientName}.`,
    invalidateKeys: [["ingredient"]],
    onSuccess: onDone,
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });

  const save = () => {
    let eachPrice: number | null = null;
    const unitMappings: UnitMappingInput[] = [];

    const dollars = parsePositive(price);
    if (dollars != null) {
      const qty = parsePositive(priceQty) ?? 1;
      const unit = priceUnit.trim() || "each";
      if (unit.toLowerCase() === "each") {
        eachPrice = dollars / qty;
      } else {
        unitMappings.push({
          a: { value: qty, unit },
          b: { value: dollars, unit: "dollar" },
          source: "manual: price (workbench)",
        });
      }
    }

    if (food == null && eachPrice == null && unitMappings.length === 0) {
      toast.error("Link a USDA food or set a price first");
      return;
    }

    createProduct.mutate({
      name: ingredientName,
      manufacturer: UNSPECIFIED_MANUFACTURER,
      upc: null,
      expectedQuantity: null,
      ingredientId,
      fdc_id: food?.fdc_id ?? null,
      price: eachPrice,
      unitMappings,
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="font-medium text-xs">
          Link a USDA food{" "}
          <span className="font-normal text-muted-foreground">
            — fills weight, volume &amp; calories
          </span>
        </p>
        <UsdaFoodSearchField
          initialQuery={ingredientName}
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
          For foods, price by the package, e.g. 2&nbsp;lb = $5.99. Use “each”
          for count items.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={createProduct.isPending}>
          {createProduct.isPending ? "Saving…" : "Create product"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

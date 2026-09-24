import type { Confidence } from "@cubby/schemas/ai";
import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { useQuery } from "@tanstack/react-query";

import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { RecipeUsagesTable } from "~/app/_components/recipe/recipe-usages-table";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";

import { EnrichmentEditor } from "./enrichment-editor";
import type { EquivalenceDraft } from "./equivalence-workbench-link";
import { ingredient } from "./ingredient.functions";

/** An AI USDA suggestion for one row, kept at the workbench level for bulk review. */
export type Suggestion = {
  food: FoodSummaryWithLinkedProducts;
  confidence: Confidence;
  reasoning: string;
};

/**
 * Surface-owned inspector around the shared enrichment editor. Recipe usages
 * stay lazy: selecting a row must not return the prior multi-megabyte worklist.
 */
export function EnrichmentWorkbenchInspector({
  row,
  initialFood,
  initialConversion,
  onDone,
}: {
  row: EnrichmentRow;
  initialFood: FoodSummaryWithLinkedProducts | null;
  initialConversion?: EquivalenceDraft;
  onDone: () => void;
}) {
  const product = row.product[0] ?? null;
  const usages = useQuery(ingredient.recipeUsages.queryOptions({ id: row.id }));

  return (
    <Stack className="p-4">
      <div>
        <h2 className="text-sm font-semibold">{row.name}</h2>
        <Description size="xs">
          Enrich the current ingredient without changing the bulk selection.
        </Description>
      </div>
      <EnrichmentEditor
        key={row.id}
        row={row}
        initialFood={initialFood}
        initialConversion={initialConversion}
        onSaved={onDone}
        layout="panel"
        slots={{
          usdaPicker: ({ food, setFood }) => (
            <>
              <UsdaFoodSearchField
                initialQuery={row.name}
                label=""
                onSelect={setFood}
              />
              {food && (
                <Row
                  as="p"
                  align="center"
                  gap="xs"
                  className="text-xs text-positive"
                >
                  <Check className="size-3" />
                  {food.foodInfo.description}
                </Row>
              )}
            </>
          ),
          actions: ({ save, isPending }) => (
            <Row align="center" gap="sm">
              <Button size="sm" onClick={save} disabled={isPending}>
                {isPending
                  ? "Saving…"
                  : product == null
                    ? "Create product"
                    : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={onDone}>
                Close
              </Button>
            </Row>
          ),
          footer:
            row.recipeCount > 0 ? (
              <Stack gap="sm">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Appears in {row.recipeCount} recipe
                  {row.recipeCount === 1 ? "" : "s"}
                </p>
                {usages.data && usages.data.length > 0 ? (
                  <div className="overflow-x-auto border border-[var(--border)] bg-background/60 p-2">
                    <RecipeUsagesTable
                      usages={usages.data}
                      ingredientName={row.name}
                      aliases={row.aliases}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {usages.isLoading ? "Loading usages…" : "No live usages."}
                  </p>
                )}
              </Stack>
            ) : null,
        }}
      />
    </Stack>
  );
}

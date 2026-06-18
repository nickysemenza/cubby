import type { Confidence } from "@cubby/schemas/ai";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { DataType } from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Field, FieldLabel } from "~/components/ui/field";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { getErrorMessage } from "~/lib/error-utils";
import { type DedupedFood, dedupeUsdaFoodsByUpc } from "~/lib/usda-food-stats";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import { confidenceColor } from "../ai/ai-suggest";
import { UsdaFoodResultRow } from "../usda/usda-food-result-row";
import { DialogCompatibleCombobox } from "./combobox-dialog";
import type { ComboboxItem } from "./combobox-types";

interface UsdaFoodSearchFieldProps {
  /**
   * Seeds the search so candidates appear immediately (e.g. the ingredient or
   * product name). The user can still type to refine. We fall back to this until
   * the user types, because `DialogCompatibleCombobox` resets its own input to "".
   * Also used as the ingredient name for the "Suggest with AI" action.
   */
  initialQuery?: string;
  label?: string;
  /** Called with the full enriched food when the user picks one. */
  onSelect: (food: FoodSummaryWithLinkedProducts) => void;
}

// Search scope → data types. "Generic" is the non-branded reference foods
// (Foundation / SR Legacy / Survey), which branded items otherwise out-rank;
// "All" leaves it to foodsOnly. Undefined ⇒ no dataTypes filter.
type SearchScope = "all" | "generic" | "branded";
const SCOPE_DATA_TYPES: Record<SearchScope, DataType[] | undefined> = {
  all: undefined,
  generic: ["foundation_food", "sr_legacy_food", "survey_fndds_food"],
  branded: ["branded_food"],
};
const SCOPES: SearchScope[] = ["all", "generic", "branded"];

/**
 * Searches USDA foods by name and reports the picked food to the parent. Unlike
 * the entity comboboxes, this does NOT bind a value to a form field — selecting a
 * food is an action (the parent sets ndb_number / upc / name from it). This is
 * the one USDA capability missing elsewhere: name-based food discovery.
 *
 * Also offers "Suggest with AI": gpt-4o-mini searches USDA itself (handling
 * wording mismatch + branded noise) and picks the best generic match.
 */
export function UsdaFoodSearchField({
  initialQuery,
  label = "Search USDA food",
  onSelect,
}: UsdaFoodSearchFieldProps) {
  const api = useTRPC();
  const trpcClient = useTRPCClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [value, setValue] = useState<ComboboxItem | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<{
    confidence: Confidence;
    reasoning: string;
  } | null>(null);

  // Until the user types, search for the seed name so the dropdown is pre-populated.
  const effectiveQuery =
    searchQuery.trim() || initialQuery?.trim() || undefined;

  const { data, isLoading } = useQuery(
    api.usda.list.queryOptions({
      // foodsOnly hides the Foundation sampling pipeline + experimental records,
      // which are provenance noise, not pickable foods. dataTypes narrows further
      // (e.g. "Generic" surfaces the reference foods branded items out-rank).
      filters: {
        nameFilter: effectiveQuery,
        foodsOnly: true,
        dataTypes: SCOPE_DATA_TYPES[scope],
      },
      // Rank by FTS relevance so the best name match leads (not alphabetical).
      sort: { orderBy: "relevance", direction: "asc" },
      // Over-fetch: USDA returns many UPC-duplicate records, so we pull extra and
      // collapse them client-side to still show a full list of distinct foods.
      pagination: { pageIndex: 0, pageSize: 50 },
    }),
  );

  const { data: aiStatus } = useQuery(
    api.ai.isAvailable.queryOptions(undefined, {
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );

  const deduped = useMemo(
    () => dedupeUsdaFoodsByUpc(data?.items ?? []),
    [data],
  );
  const foodsById = useMemo(() => {
    const map = new Map<string, DedupedFood>();
    for (const entry of deduped) map.set(String(entry.food.fdc_id), entry);
    return map;
  }, [deduped]);

  const items: ComboboxItem[] = deduped.map((entry) => ({
    id: String(entry.food.fdc_id),
    name: entry.food.foodInfo.description,
  }));

  // Shared by manual pick and AI: reflect the choice in the combobox and notify parent.
  const applyFood = useCallback(
    (food: FoodSummaryWithLinkedProducts) => {
      setValue({ id: String(food.fdc_id), name: food.foodInfo.description });
      onSelect(food);
    },
    [onSelect],
  );

  const handleSuggest = useCallback(async () => {
    const name = initialQuery?.trim();
    if (!name) return;
    setIsSuggesting(true);
    try {
      const result = await trpcClient.ai.suggestUsdaFood.mutate({
        ingredientName: name,
      });
      if (result.food) {
        applyFood(result.food);
        setSuggestion({
          confidence: result.confidence,
          reasoning: result.reasoning,
        });
      } else {
        setSuggestion(null);
        toast.message("No confident USDA match — search manually.", {
          description: result.reasoning,
        });
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsSuggesting(false);
    }
  }, [initialQuery, trpcClient, applyFood]);

  const canSuggest = !!aiStatus?.available && !!initialQuery?.trim();

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-1">
        {SCOPES.map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={scope === s ? "secondary" : "outline"}
            className="h-6 px-2 text-xs capitalize"
            onClick={() => setScope(s)}
          >
            {s}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <DialogCompatibleCombobox
            label="USDA food"
            items={items}
            isLoading={isLoading}
            onSearchChange={setSearchQuery}
            value={value}
            wide
            renderItem={(item) => {
              const entry = foodsById.get(item.id);
              return entry ? (
                <UsdaFoodResultRow
                  food={entry.food}
                  duplicateCount={entry.duplicateCount}
                />
              ) : (
                item.name
              );
            }}
            setValue={(item) => {
              if (!item) {
                setValue(null);
                return;
              }
              const entry = foodsById.get(item.id);
              if (entry) applyFood(entry.food);
              else setValue(item);
            }}
          />
        </div>
        {aiStatus?.available && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSuggest}
                  disabled={!canSuggest || isSuggesting}
                />
              }
            >
              {isSuggesting ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              <span className="ml-1 hidden sm:inline">Suggest with AI</span>
            </TooltipTrigger>
            <TooltipContent>
              {!initialQuery?.trim()
                ? "Enter a name first"
                : "Let AI pick the best USDA food"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {suggestion && (
        <div className="rounded-md bg-muted/50 p-2 text-sm">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium">AI match:</span>
            <span className={confidenceColor[suggestion.confidence]}>
              {suggestion.confidence} confidence
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">{suggestion.reasoning}</p>
        </div>
      )}
    </Field>
  );
}

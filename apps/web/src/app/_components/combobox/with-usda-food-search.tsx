import type { Confidence } from "@cubby/schemas/ai";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import type { DataType } from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import {
  AiProposalCard,
  AiProvenance,
} from "~/app/_components/ai/ai-proposal-card";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { showErrorToast } from "~/components/feedback/error-details";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { usdaFood } from "~/entities/usda.functions";
import { ai } from "~/lib/ai.functions";
import { parseUsdaFoodRef } from "~/lib/parse-usda-food-ref";
import { type DedupedFood, dedupeUsdaFoodsByUpc } from "~/lib/usda-food-stats";

import { UsdaFoodResultRow } from "../usda/usda-food-result-row";
import type { ComboboxItem } from "./combobox-types";
import { EntityPicker } from "./entity-picker";

interface UsdaFoodSearchFieldProps {
  /**
   * Seeds the search so candidates appear immediately (e.g. the ingredient or
   * product name). The user can still type to refine. We fall back to this until
   * the user types, because `EntityPicker` resets its own input to "".
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
const SCOPE_DATA_TYPES = {
  all: undefined,
  generic: ["foundation_food", "sr_legacy_food", "survey_fndds_food"],
  branded: ["branded_food"],
} satisfies Record<SearchScope, DataType[] | undefined>;
const SCOPES: SearchScope[] = ["all", "generic", "branded"];

/**
 * Searches USDA foods by name and reports the picked food to the parent. Unlike
 * the entity comboboxes, this does NOT bind a value to a form field — selecting a
 * food is an action (the parent sets ndb_number / upc / name from it). This is
 * the one USDA capability missing elsewhere: name-based food discovery.
 *
 * Also offers "Suggest USDA food": the fast tier searches USDA itself
 * (handling wording mismatch + branded noise) and picks the best generic
 * match. The pick is a **proposal** — it is shown with its reasoning and only
 * written to the field on Accept. It used to apply itself and explain
 * afterwards, which meant the confidence and the reasoning arrived after the
 * only decision they could have informed.
 */
export function UsdaFoodSearchField({
  initialQuery,
  label = "Search USDA food",
  onSelect,
}: UsdaFoodSearchFieldProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [value, setValue] = useState<ComboboxItem | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<{
    food: FoodSummaryWithLinkedProducts;
    confidence: Confidence;
    reasoning: string;
    at: Date;
  } | null>(null);

  // A pasted USDA food URL / bare fdc_id jumps straight to that one food — name
  // search can't surface every exact match (e.g. a literal "VANILLA BEAN" sits
  // behind thousands of branded rows). When parsed, we resolve by id and bypass FTS.
  const parsedFdcId = useMemo(
    () => parseUsdaFoodRef(searchQuery),
    [searchQuery],
  );

  // Until the user types, search for the seed name so the dropdown is pre-populated.
  const effectiveQuery =
    parsedFdcId != null
      ? undefined
      : searchQuery.trim() || initialQuery?.trim() || undefined;

  const { data, isLoading } = useQuery({
    ...usdaFood.list.queryOptions({
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
    // Skip FTS entirely when the input is a URL/id — getByID drives the list.
    enabled: parsedFdcId == null,
  });

  const { data: byIdFood, isLoading: byIdLoading } = useQuery({
    // Disabled queries still construct and validate their options. USDA ids
    // are positive integers, so keep the dormant key schema-valid.
    ...usdaFood.detail.queryOptions({ id: parsedFdcId ?? 1 }),
    enabled: parsedFdcId != null,
  });

  const deduped = useMemo(
    () =>
      parsedFdcId != null
        ? byIdFood
          ? [{ food: byIdFood, duplicateCount: 0 }]
          : []
        : dedupeUsdaFoodsByUpc(data?.items ?? []),
    [parsedFdcId, byIdFood, data],
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
      const result = await ai.suggestUsdaFood.call({
        ingredientName: name,
      });
      if (result.food) {
        setSuggestion({
          food: result.food,
          confidence: result.confidence,
          reasoning: result.reasoning,
          at: new Date(),
        });
      } else {
        setSuggestion(null);
        toast.message("No confident USDA match — search manually.", {
          description: result.reasoning,
        });
      }
    } catch (error) {
      showErrorToast(error);
    } finally {
      setIsSuggesting(false);
    }
  }, [initialQuery]);

  const canSuggest = !!initialQuery?.trim();

  return (
    <FormFieldGroup label={label}>
      <Row gap="xs">
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
      </Row>
      <Row align="center" gap="sm">
        <div className="flex-1">
          <EntityPicker
            label="USDA food"
            items={items}
            isLoading={parsedFdcId != null ? byIdLoading : isLoading}
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
        <VerbButton
          verb="suggest"
          object="USDA food"
          phoneIconOnly
          pending={isSuggesting}
          disabledReason={canSuggest ? undefined : "Enter a name first"}
          className="min-h-9 max-sm:min-h-11"
          onClick={() => void handleSuggest()}
        />
      </Row>

      {!canSuggest && (
        <Description size="xs">
          Enter a name first — AI needs something to look up.
        </Description>
      )}

      {suggestion && (
        <AiProposalCard
          label="Suggested USDA food"
          confidence={suggestion.confidence}
          reasoning={suggestion.reasoning}
          provenance={<AiProvenance analyzedAt={suggestion.at} />}
          onAccept={() => {
            applyFood(suggestion.food);
            setSuggestion(null);
          }}
          onDismiss={() => setSuggestion(null)}
        >
          <div className="border border-border bg-background p-2">
            <UsdaFoodResultRow food={suggestion.food} />
          </div>
        </AiProposalCard>
      )}
    </FormFieldGroup>
  );
}

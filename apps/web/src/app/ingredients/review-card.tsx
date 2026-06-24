import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import { useQuery } from "@tanstack/react-query";
import { GitMerge, Search } from "lucide-react";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import { ConfidenceReasoningCard } from "~/app/_components/ai/ai-suggest";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { UsdaFoodResultRow } from "~/app/_components/usda/usda-food-result-row";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { dedupeUsdaFoodsByUpc } from "~/lib/usda-food-stats";
import type { EnrichmentProposal } from "~/server/services/ai-enrichment.service";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import {
  EnrichmentEditor,
  type EnrichmentEditorHandle,
} from "./enrichment-editor";
import { hasUsdaLink } from "./workbench-editor-core";

// Up to this many alternative USDA foods alongside the AI pick.
const MAX_ALTERNATIVES = 5;

/** A merge target offered for the current ingredient (AI pick or trigram hit). */
export interface MergeOption {
  id: string;
  name: string;
  source: "ai" | "fuzzy";
  /** pg_trgm similarity 0–1 (fuzzy candidates only). */
  similarity?: number;
}

/**
 * The queue's USDA picker — the editor's `usdaPicker` slot (rendered only when the
 * row isn't already linked). Encapsulates ALL the AI chrome: confidence +
 * reasoning, rich detail for the selected food, alternative matches to switch to,
 * a manual search, and seeding the food from the proposal once it arrives.
 */
function QueueUsdaPicker({
  food,
  setFood,
  proposal,
  proposalPending,
  rowName,
}: {
  food: FoodSummaryWithLinkedProducts | null;
  setFood: (food: FoodSummaryWithLinkedProducts) => void;
  proposal: EnrichmentProposal | undefined;
  proposalPending: boolean;
  rowName: string;
}) {
  const api = useTRPC();
  const usda = proposal?.usda ?? null;
  const noMatch = usda != null && usda.food == null;
  const [showSearch, setShowSearch] = useState(false);

  // Seed the food from the proposal once it lands, unless the user already picked.
  const pickedRef = useRef(false);
  const pick = (f: FoodSummaryWithLinkedProducts) => {
    pickedRef.current = true;
    setFood(f);
  };
  const proposalFood = usda?.food ?? null;
  useEffect(() => {
    if (proposalFood && !pickedRef.current) setFood(proposalFood);
  }, [proposalFood, setFood]);

  // Other USDA options (generic reference foods, relevance-ranked, deduped).
  const { data: altData, isLoading: altLoading } = useQuery(
    api.usda.list.queryOptions({
      filters: {
        nameFilter: rowName,
        foodsOnly: true,
        dataTypes: ["foundation_food", "sr_legacy_food", "survey_fndds_food"],
      },
      sort: { orderBy: "relevance", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 20 },
    }),
  );
  const alternatives = useMemo(() => {
    const deduped = dedupeUsdaFoodsByUpc(altData?.items ?? []);
    return deduped
      .filter((d) => d.food.fdc_id !== food?.fdc_id)
      .slice(0, MAX_ALTERNATIVES);
  }, [altData, food]);

  return (
    <div className="space-y-2">
      {usda && (
        <ConfidenceReasoningCard
          confidence={usda.confidence}
          reasoning={usda.reasoning}
          label={noMatch ? "No confident match" : "AI match"}
        />
      )}
      {proposalPending && usda == null && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner className="h-3 w-3" /> Finding a USDA match…
        </p>
      )}

      {food && (
        <div className="rounded-md border border-positive/40 bg-positive/5 p-2">
          <p className="mb-1 font-medium text-2xs text-positive uppercase tracking-wide">
            Selected
          </p>
          <UsdaFoodResultRow food={food} />
        </div>
      )}

      {!noMatch && (alternatives.length > 0 || altLoading) && (
        <div className="space-y-1.5">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Other USDA matches
          </p>
          {altLoading && alternatives.length === 0 ? (
            <p className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="h-3 w-3" /> Searching…
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {alternatives.map((alt) => (
                <button
                  key={alt.food.fdc_id}
                  type="button"
                  onClick={() => pick(alt.food)}
                  className="block w-full px-2 py-1.5 text-left hover:bg-accent/50"
                >
                  <UsdaFoodResultRow
                    food={alt.food}
                    duplicateCount={alt.duplicateCount}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {noMatch || showSearch ? (
        <UsdaFoodSearchField
          initialQuery={rowName}
          label={food ? "Replace USDA food" : "Search USDA food"}
          onSelect={pick}
        />
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => setShowSearch(true)}
        >
          <Search className="h-3 w-3" />
          Search manually <Kbd className="ml-1">u</Kbd>
        </Button>
      )}
    </div>
  );
}

interface ReviewCardProps {
  row: EnrichmentRow;
  proposal: EnrichmentProposal | undefined;
  /** Cache still working and this row hasn't a proposal yet. */
  proposalPending: boolean;
  editorRef: Ref<EnrichmentEditorHandle>;
  onSaved: () => void;
  mergeOptions: MergeOption[];
  onMerge: (option: MergeOption) => void;
  canMarkNoUsda: boolean;
  onMarkNoUsda: () => void;
  position: { index: number; total: number };
}

/**
 * One ingredient's review card: the shared {@link EnrichmentEditor} (gap-aware —
 * shows only the inputs the row needs) wrapped in the queue's chrome. For an
 * already-linked row the editor hides the USDA picker entirely, so there's no
 * misleading matcher — just the price/conversion gap to close.
 */
export function ReviewCard({
  row,
  proposal,
  proposalPending,
  editorRef,
  onSaved,
  mergeOptions,
  onMerge,
  canMarkNoUsda,
  onMarkNoUsda,
  position,
}: ReviewCardProps) {
  const usdaLinked = hasUsdaLink(row);

  return (
    <div className="rounded-lg border bg-background p-4 shadow-sm">
      <EnrichmentEditor
        ref={editorRef}
        row={row}
        onSaved={onSaved}
        slots={{
          header: (
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-lg">{row.name}</div>
                <div className="text-muted-foreground text-xs">
                  × {row.recipeCount} recipe{row.recipeCount === 1 ? "" : "s"}
                  {row.product.length > 0 && " · has product"}
                </div>
              </div>
              <div className="text-right text-muted-foreground text-xs">
                {position.index + 1} of {position.total}
              </div>
            </div>
          ),
          usdaPicker: ({ food, setFood }) => (
            <QueueUsdaPicker
              food={food}
              setFood={setFood}
              proposal={proposal}
              proposalPending={proposalPending}
              rowName={row.name}
            />
          ),
          actions: ({ save, isPending }) => (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={save} disabled={isPending}>
                {isPending ? "Applying…" : "Apply"}
                <Kbd className="ml-1.5">↵</Kbd>
              </Button>
              {canMarkNoUsda && (
                <Button
                  variant="outline"
                  onClick={onMarkNoUsda}
                  disabled={isPending}
                >
                  No USDA entry <Kbd className="ml-1">n</Kbd>
                </Button>
              )}
            </div>
          ),
          footer: (
            <div className="space-y-3">
              {mergeOptions.length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                    Possible duplicate{mergeOptions.length === 1 ? "" : "s"}
                  </p>
                  <div className="divide-y rounded-md border border-dashed">
                    {mergeOptions.map((opt, i) => (
                      <div
                        key={opt.id}
                        className="flex items-center gap-2 px-2 py-1.5 text-sm"
                      >
                        <span className="font-medium">{opt.name}</span>
                        <span className="text-2xs text-muted-foreground">
                          {opt.source === "ai"
                            ? "AI"
                            : `${Math.round((opt.similarity ?? 0) * 100)}% match`}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="ml-auto h-6 px-2 text-xs"
                          onClick={() => onMerge(opt)}
                        >
                          <GitMerge className="h-3 w-3" /> Merge
                          {i === 0 && <Kbd className="ml-1">m</Kbd>}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-2xs text-muted-foreground">
                <span>
                  <Kbd>↵</Kbd> Apply
                </span>
                {!usdaLinked && (
                  <span>
                    <Kbd>u</Kbd> Search
                  </span>
                )}
                <span>
                  <Kbd>m</Kbd> Merge
                </span>
                <span>
                  <Kbd>s</Kbd> Skip
                </span>
                <span>
                  <Kbd>n</Kbd> No USDA
                </span>
                <span>
                  <KbdGroup>
                    <Kbd>j</Kbd>
                    <Kbd>k</Kbd>
                  </KbdGroup>{" "}
                  Nav
                </span>
                <span>
                  <Kbd>esc</Kbd> Back
                </span>
              </div>
            </div>
          ),
        }}
      />
    </div>
  );
}

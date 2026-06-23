import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import { GitMerge, Search } from "lucide-react";
import { useMemo } from "react";
import { ConfidenceReasoningCard } from "~/app/_components/ai/ai-suggest";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import {
  isDisplayMapping,
  UnitMappingGraph,
} from "~/app/_components/units/unit-mapping-graph";
import { UnitMappingsTable } from "~/app/_components/units/unitmappingstable";
import { UsdaFoodResultRow } from "~/app/_components/usda/usda-food-result-row";
import { CoverageChips } from "~/app/problems/components/unit-coverage-fix";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { dedupeUsdaFoodsByUpc } from "~/lib/usda-food-stats";
import type { EnrichmentProposal } from "~/server/services/ai-enrichment.service";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { buildPreviewMappings, UnitInput } from "./workbench-editor-core";

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

interface ReviewCardProps {
  row: EnrichmentRow;
  proposal: EnrichmentProposal | undefined;
  /** Cache still working and this row hasn't a proposal yet. */
  proposalPending: boolean;
  food: FoodSummaryWithLinkedProducts | null;
  onPickFood: (food: FoodSummaryWithLinkedProducts) => void;
  dollars: string;
  qty: string;
  unit: string;
  onPrice: (
    patch: Partial<{ dollars: string; qty: string; unit: string }>,
  ) => void;
  showReplace: boolean;
  onToggleReplace: () => void;
  onApply: (withPrice: boolean) => void;
  mergeOptions: MergeOption[];
  onMerge: (option: MergeOption) => void;
  canMarkNoUsda: boolean;
  onMarkNoUsda: () => void;
  isPending: boolean;
  position: { index: number; total: number };
}

/**
 * The focused single-ingredient review card. Presentational: all queue state and
 * the keyboard model live in the parent `ReviewQueue`. Shows the AI USDA proposal
 * with full result-row detail, a few alternative matches to switch to, a price
 * entry, and the same live unit-graph + coverage panels as the Browse editor.
 */
export function ReviewCard({
  row,
  proposal,
  proposalPending,
  food,
  onPickFood,
  dollars,
  qty,
  unit,
  onPrice,
  showReplace,
  onToggleReplace,
  onApply,
  mergeOptions,
  onMerge,
  canMarkNoUsda,
  onMarkNoUsda,
  isPending,
  position,
}: ReviewCardProps) {
  const api = useTRPC();
  const usda = proposal?.usda ?? null;
  const noMatch = usda != null && usda.food == null;

  // Other USDA options to switch to — the generic reference foods, ranked by
  // relevance, deduped by UPC (same as the search dropdown). One cheap USDA-worker
  // query per card; excludes whatever food is currently picked.
  const { data: altData, isLoading: altLoading } = useQuery(
    api.usda.list.queryOptions({
      filters: {
        nameFilter: row.name,
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

  // The mapping graph / coverage as they would be once this edit lands — shared
  // computation with the Browse editor.
  const previewMappings = useMemo<UnitMapping[]>(
    () => buildPreviewMappings(row, { food, dollars, qty, unit }),
    [row, food, dollars, qty, unit],
  );
  const currentMappings = useMemo<UnitMapping[]>(() => {
    try {
      return getIngredientMappings(row).filter(isDisplayMapping);
    } catch {
      return [];
    }
  }, [row]);
  const linkedFoods = row.product
    .map((p) => p.food)
    .filter((f): f is NonNullable<typeof f> => f != null);

  // Enter applies (Shift+Enter without price) from the text unit input too — the
  // number inputs are handled by the queue's global key handler.
  const onUnitKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onApply(!e.shiftKey);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border bg-background p-4 shadow-sm">
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

      <CoverageChips
        covered={row.coverage.covered}
        applicable={row.coverage.applicable}
      />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* Left: proposal, alternatives, price, actions */}
        <div className="min-w-0 flex-1 space-y-3">
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

          {/* The picked food, with full USDA detail */}
          {food && (
            <div className="rounded-md border border-positive/40 bg-positive/5 p-2">
              <p className="mb-1 font-medium text-2xs text-positive uppercase tracking-wide">
                Selected
              </p>
              <UsdaFoodResultRow food={food} />
            </div>
          )}

          {/* Alternatives to switch to */}
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
                      onClick={() => onPickFood(alt.food)}
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

          {/* Manual search (always reachable; auto-open when no match) */}
          {noMatch || showReplace ? (
            <UsdaFoodSearchField
              initialQuery={row.name}
              label={food ? "Replace USDA food" : "Search USDA food"}
              onSelect={onPickFood}
            />
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={onToggleReplace}
            >
              <Search className="h-3 w-3" />
              Search manually <Kbd className="ml-1">u</Kbd>
            </Button>
          )}

          {/* Price */}
          <div className="space-y-1">
            <p className="font-medium text-xs">Set a price</p>
            <div className="flex items-center gap-1.5 text-sm">
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                value={qty}
                onChange={(e) => onPrice({ qty: e.target.value })}
                className="w-12"
                aria-label="Price quantity"
              />
              <UnitInput
                value={unit}
                onChange={(v) => onPrice({ unit: v })}
                onKeyDown={onUnitKeyDown}
                ariaLabel="Price unit"
              />
              <span>= $</span>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={dollars}
                onChange={(e) => onPrice({ dollars: e.target.value })}
                className="w-24"
                aria-label="Price"
                autoFocus
              />
            </div>
            <p className="text-2xs text-muted-foreground">
              Price by the package, e.g. 2&nbsp;lb = $5.99. Use “each” for count
              items.
            </p>
          </div>

          {/* Merge candidates — AI pick first, then trigram hits */}
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

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => onApply(true)} disabled={isPending}>
              {isPending ? "Applying…" : "Apply"}
              <Kbd className="ml-1.5">↵</Kbd>
            </Button>
            <Button
              variant="ghost"
              onClick={() => onApply(false)}
              disabled={isPending}
            >
              Link without price
              <KbdGroup className="ml-1.5">
                <Kbd>⇧</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
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
        </div>

        {/* Right: live unit graph + coverage + current state */}
        <div className="shrink-0 space-y-3 lg:w-72">
          <div className="space-y-1">
            <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Unit graph (live)
            </p>
            <UnitMappingGraph mappings={previewMappings} />
          </div>
          <div className="space-y-1">
            <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Coverage (live)
            </p>
            <div className="rounded-md border bg-background/60 p-2">
              <ConversionCapabilities
                mappings={previewMappings}
                kinds={row.coverage.applicable}
                hideConvertButton
              />
            </div>
          </div>
          {(linkedFoods.length > 0 || currentMappings.length > 0) && (
            <div className="space-y-1 rounded-md border bg-background/60 p-2 text-xs">
              {linkedFoods.length > 0 && (
                <p className="text-muted-foreground">
                  Linked USDA:{" "}
                  {linkedFoods.map((f) => f.foodInfo.description).join(", ")}
                </p>
              )}
              {currentMappings.length > 0 && (
                <UnitMappingsTable mappings={currentMappings} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Shortcut legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-2xs text-muted-foreground">
        <span>
          <Kbd>↵</Kbd> Apply
        </span>
        <span>
          <KbdGroup>
            <Kbd>⇧</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>{" "}
          No price
        </span>
        <span>
          <Kbd>u</Kbd> Search
        </span>
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
  );
}

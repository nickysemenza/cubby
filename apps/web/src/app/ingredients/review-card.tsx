import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useQuery } from "@tanstack/react-query";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";

import { verbDef } from "~/app/_components/actions/action-verbs";
import {
  AiProposalCard,
  AiProvenance,
} from "~/app/_components/ai/ai-proposal-card";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { QueuePassPosition } from "~/app/_components/queue-pass/QueuePassProgress";
import { UsdaFoodResultRow } from "~/app/_components/usda/usda-food-result-row";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { usdaFood } from "~/entities/usda.functions";
import { dedupeUsdaFoodsByUpc } from "~/lib/usda-food-stats";
import type { EnrichmentProposal } from "~/server/services/ai-enrichment/proposals";

import {
  EnrichmentEditor,
  type EnrichmentEditorHandle,
} from "./enrichment-editor";
import { hasUsdaLink } from "./workbench-editor-core";

// Single-sourced from the action-verb registry so the workbench can't drift
// from the ingredient list's own Merge — it had been rendering `GitMerge`
// where every other merge affordance uses `Merge`. Only the presentation is
// borrowed; these buttons keep their compact review-card density.
const { icon: MergeIcon, label: mergeLabel } = verbDef("merge");

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
    usdaFood.list.queryOptions({
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
    <Stack gap="sm">
      {usda && (
        // Evidence only: the editor's own Apply is the acceptance, so the card
        // carries no Accept/Dismiss of its own to compete with it.
        <AiProposalCard
          confidence={usda.confidence}
          reasoning={usda.reasoning}
          label={noMatch ? "No confident match" : "AI match"}
          provenance={<AiProvenance />}
        />
      )}
      {proposalPending && usda == null && (
        <Row
          as="p"
          align="center"
          gap="sm"
          className="text-sm text-muted-foreground"
        >
          <Spinner className="size-3" /> Finding a USDA match…
        </Row>
      )}

      {food && (
        <div className="border border-positive/40 bg-positive/5 p-2">
          <p className="mb-1 text-2xs font-medium tracking-wide text-positive uppercase">
            Selected
          </p>
          <UsdaFoodResultRow food={food} />
        </div>
      )}

      {!noMatch && (alternatives.length > 0 || altLoading) && (
        <Stack gap="sm">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Other USDA matches
          </p>
          {altLoading && alternatives.length === 0 ? (
            <Row
              as="p"
              align="center"
              gap="sm"
              className="text-xs text-muted-foreground"
            >
              <Spinner className="size-3" /> Searching…
            </Row>
          ) : (
            <div className="divide-y border border-[var(--border)]">
              {alternatives.map((alt) => (
                <button
                  key={alt.food.fdc_id}
                  type="button"
                  onClick={() => pick(alt.food)}
                  className="block w-full px-2 py-2 text-left hover:bg-accent/50"
                >
                  <UsdaFoodResultRow
                    food={alt.food}
                    duplicateCount={alt.duplicateCount}
                  />
                </button>
              ))}
            </div>
          )}
        </Stack>
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
          <Search className="size-3" />
          Search manually <Kbd className="ml-1">u</Kbd>
        </Button>
      )}
    </Stack>
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
    <div className="border border-[var(--border)] bg-background p-4">
      <EnrichmentEditor
        ref={editorRef}
        row={row}
        onSaved={onSaved}
        slots={{
          header: (
            <Row align="start" justify="between" gap="sm">
              <div>
                <div className="text-lg font-medium">{row.name}</div>
                <div className="text-xs text-muted-foreground">
                  × {row.recipeCount} recipe{row.recipeCount === 1 ? "" : "s"}
                  {row.product.length > 0 && " · has product"}
                </div>
              </div>
              <QueuePassPosition
                index={position.index}
                total={position.total}
              />
            </Row>
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
            <Row align="center" wrap gap="sm">
              <Button onClick={save} disabled={isPending}>
                {isPending ? "Applying…" : "Apply"}
                <Kbd className="ml-2">↵</Kbd>
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
            </Row>
          ),
          footer: (
            <Stack gap="sm">
              {mergeOptions.length > 0 && (
                <Stack gap="xs">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Possible duplicate{mergeOptions.length === 1 ? "" : "s"}
                  </p>
                  <div className="divide-y border border-dashed">
                    {mergeOptions.map((opt, i) => (
                      <Row
                        key={opt.id}
                        align="center"
                        gap="sm"
                        className="px-2 py-2 text-sm"
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
                          <MergeIcon className="size-3" /> {mergeLabel}
                          {i === 0 && <Kbd className="ml-1">m</Kbd>}
                        </Button>
                      </Row>
                    ))}
                  </div>
                </Stack>
              )}

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2 text-2xs text-muted-foreground">
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
            </Stack>
          ),
        }}
      />
    </div>
  );
}

import type { Confidence } from "@cubby/schemas/ai";
import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { type Ref, useState } from "react";

import { verbDef } from "~/app/_components/actions/action-verbs";
import { confidenceColor } from "~/app/_components/ai/ai-suggest";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { RecipeUsagesTable } from "~/app/_components/recipe/recipe-usages-table";
import { CoverageChips } from "~/app/problems/components/unit-coverage-fix";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";

import { EnrichmentEditor } from "./enrichment-editor";
import type { EquivalenceDraft } from "./equivalence-workbench-link";
import { ingredient } from "./ingredient.functions";
import { fixBadgeLabel } from "./workbench-fix-label";

// Single-sourced from the action-verb registry so the workbench can't drift
// from the ingredient list's own Merge — it had been rendering `GitMerge`
// where every other merge affordance uses `Merge`. Only the presentation is
// borrowed; these buttons keep their compact review-card density.
const { icon: MergeIcon, label: mergeLabel } = verbDef("merge");

/** An AI USDA suggestion for one row, kept at the table level for bulk review. */
export type Suggestion = {
  food: FoodSummaryWithLinkedProducts;
  confidence: Confidence;
  reasoning: string;
};

/** Inline "≈ candidate · Merge" hint shown under an ingredient name. */
function MergeHint({
  tone,
  targetName,
  onMerge,
}: {
  tone: "ai" | "fuzzy";
  targetName: string;
  onMerge: () => void;
}) {
  return (
    <Row align="center" gap="sm" className="mt-1">
      <span
        className={cn(
          "text-xs",
          tone === "ai" ? "text-info" : "text-muted-foreground",
        )}
      >
        {tone === "ai" ? "≈" : "possible dup:"} {targetName}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        onClick={(e) => {
          e.stopPropagation();
          onMerge();
        }}
      >
        <MergeIcon className="size-3" />
        {mergeLabel}
      </Button>
    </Row>
  );
}

export function WorkbenchRow({
  row,
  selected,
  onToggle,
  suggestion,
  mergeSuggestion,
  onRequestMerge,
  defaultOpen = false,
  initialConversion,
  rowRef,
}: {
  row: EnrichmentRow;
  selected: boolean;
  onToggle: () => void;
  suggestion: Suggestion | null;
  mergeSuggestion: {
    targetId: string;
    targetName: string;
  } | null;
  onRequestMerge: (pair: {
    source: { id: string; name: string };
    target: { id: string; name: string };
  }) => void;
  /** Start expanded (deep-link focus from the Problems page). */
  defaultOpen?: boolean;
  initialConversion?: EquivalenceDraft;
  /** Ref on the row's first <tr>, so the parent can scroll it into view. */
  rowRef?: Ref<HTMLTableRowElement>;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <TableRow
        ref={rowRef}
        className={cn(
          "cursor-pointer hover:bg-accent/40",
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
        <TableCell>
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label={`Select ${row.name}`}
          />
        </TableCell>
        <TableCell className="text-muted-foreground">
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </TableCell>
        <TableCell className="whitespace-normal">
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-muted-foreground">
            × {row.recipeCount} recipe{row.recipeCount === 1 ? "" : "s"}
            {suggestion && (
              <span className="text-info ml-2">
                · AI: {suggestion.food.foodInfo.description}{" "}
                <span className={confidenceColor[suggestion.confidence]}>
                  ({suggestion.confidence})
                </span>
              </span>
            )}
          </div>
          {mergeSuggestion ? (
            <MergeHint
              tone="ai"
              targetName={mergeSuggestion.targetName}
              onMerge={() =>
                onRequestMerge({
                  source: {
                    id: row.id,
                    name: row.name,
                  },
                  target: {
                    id: mergeSuggestion.targetId,
                    name: mergeSuggestion.targetName,
                  },
                })
              }
            />
          ) : (
            // Tier-1/2 trigram near-dup hint — no AI call needed. Suggestion only;
            // the confirm dialog guards against false positives.
            row.mergeCandidates[0] && (
              <MergeHint
                tone="fuzzy"
                targetName={row.mergeCandidates[0].name}
                onMerge={() => {
                  const cand = row.mergeCandidates[0];
                  if (cand)
                    onRequestMerge({
                      source: {
                        id: row.id,
                        name: row.name,
                      },
                      target: {
                        id: cand.id,
                        name: cand.name,
                      },
                    });
                }}
              />
            )
          )}
        </TableCell>
        <TableCell>
          <CoverageChips
            covered={row.coverage.covered}
            applicable={row.coverage.applicable}
          />
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="font-normal">
            {fixBadgeLabel(row)}
          </Badge>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/20">
          <TableCell />
          <TableCell />
          <TableCell colSpan={3} className="pr-4 whitespace-normal">
            <WorkbenchEditor
              row={row}
              initialFood={suggestion?.food ?? null}
              initialConversion={initialConversion}
              onDone={() => setOpen(false)}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Browse-table chrome around the shared {@link EnrichmentEditor}: a plain USDA
 * search picker, Save/Cancel, and the recipe-usages footer. All the gap-aware
 * editing (link/price/conversions/N-A + live graph) lives in EnrichmentEditor,
 * shared with the review card so the two can't drift.
 */
function WorkbenchEditor({
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

  // Recipe usages are fetched lazily (this editor mounts only when the row is
  // expanded) so the worklist query stays lean — it no longer ships every usage's
  // recipe body per row.
  const usages = useQuery(ingredient.recipeUsages.queryOptions({ id: row.id }));

  return (
    <EnrichmentEditor
      row={row}
      initialFood={initialFood}
      initialConversion={initialConversion}
      onSaved={onDone}
      layout="compact"
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
              Cancel
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
  );
}

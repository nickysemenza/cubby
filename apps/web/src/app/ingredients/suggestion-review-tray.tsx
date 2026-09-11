import type { EnrichmentRow } from "@cubby/schemas/ingredient";

import { AiProvenance } from "~/app/_components/ai/ai-proposal-card";
import { AiProposalList } from "~/app/_components/ai/ai-proposal-list";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Progress } from "~/components/ui/progress";

import { UnitInput } from "./workbench-editor-core";
import type { Suggestion } from "./workbench-row";

type SuggestionPrice = { dollars: string; qty: string; unit: string };

/**
 * The bulk-review tray for pending AI USDA suggestions. Each suggestion can be
 * rejected or given an optional package price before bulk-creating products.
 * Purely presentational — all state lives in {@link EnrichmentWorkbench}.
 *
 * On the shared {@link AiProposalList} so it reads like the other multi-row AI
 * surfaces. Two things the tray was missing come with it: the reasoning is
 * visible rather than sitting in a `title` tooltip no touch device can open,
 * and "Reject all" exists — previously the only way out of thirty suggestions
 * you disagreed with was thirty ✕ taps. Acceptance stays a single bulk create
 * (`onAcceptAll`), because that is genuinely one request, not N.
 */
export function SuggestionReviewTray({
  rows,
  suggestions,
  suggestionPrices,
  creatableCount,
  isPending,
  progress,
  onCreate,
  onReject,
  onPriceChange,
}: {
  rows: EnrichmentRow[];
  suggestions: Record<string, Suggestion>;
  suggestionPrices: Record<string, SuggestionPrice>;
  creatableCount: number;
  isPending: boolean;
  progress: { done: number; total: number } | null | undefined;
  onCreate: () => void;
  onReject: (id: string) => void;
  onPriceChange: (id: string, patch: Partial<SuggestionPrice>) => void;
}) {
  const proposalRows = Object.entries(suggestions).flatMap(([id, sug]) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return [];
    const price = suggestionPrices[id] ?? { dollars: "", qty: "1", unit: "lb" };
    return [
      {
        id,
        title: `${row.name} → ${sug.food.foodInfo.description}`,
        confidence: sug.confidence,
        reasoning: sug.reasoning,
        aside: (
          <Row as="span" align="center" gap="xs" className="text-xs">
            <span className="text-muted-foreground">$</span>
            <Input
              value={price.dollars}
              onChange={(event) =>
                onPriceChange(id, { dollars: event.target.value })
              }
              placeholder="price"
              aria-label={`Price for ${row.name}`}
              className="h-7 w-16 max-sm:h-11"
            />
            <span className="text-muted-foreground">/</span>
            <Input
              value={price.qty}
              onChange={(event) =>
                onPriceChange(id, { qty: event.target.value })
              }
              aria-label={`Price quantity for ${row.name}`}
              className="h-7 w-12 max-sm:h-11"
            />
            <UnitInput
              value={price.unit}
              onChange={(value) => onPriceChange(id, { unit: value })}
              ariaLabel={`Price unit for ${row.name}`}
            />
          </Row>
        ),
      },
    ];
  });

  return (
    <Stack gap="sm">
      {progress && <Progress value={progress.done} max={progress.total} />}
      <AiProposalList
        heading="USDA suggestions"
        // The proposals arrive through the enrichment precompute cache, which
        // returns the match alone — no model, no analysis timestamp. Widening
        // `EnrichmentProposal` is what would fill this in.
        provenance={<AiProvenance />}
        rows={proposalRows}
        onReject={onReject}
        onAcceptAll={onCreate}
        acceptAllLabel={`Create ${creatableCount} product${creatableCount === 1 ? "" : "s"}`}
        rejectAllLabel="Reject all"
        pending={isPending}
        acceptAllDisabled={creatableCount === 0}
        footer={
          <Description size="2xs">
            Price optional — leave blank to create the USDA link and price
            later. Foods are usually priced by package (e.g. $5.99 / 2 lb); a
            unit of “each” stores a per-item price.
          </Description>
        }
      />
    </Stack>
  );
}

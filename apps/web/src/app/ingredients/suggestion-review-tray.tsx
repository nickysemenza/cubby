import { X } from "lucide-react";
import { confidenceColor } from "~/app/_components/ai/ai-suggest";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Progress } from "~/components/ui/progress";
import { cn } from "~/lib/utils";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { UnitInput } from "./workbench-editor-core";
import type { Suggestion } from "./workbench-row";

type SuggestionPrice = { dollars: string; qty: string; unit: string };

/**
 * The bulk-review tray for pending AI USDA suggestions. Each suggestion can be
 * rejected or given an optional package price before bulk-creating products.
 * Purely presentational — all state lives in {@link EnrichmentWorkbench}.
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
  const suggestionCount = Object.keys(suggestions).length;

  return (
    <Stack
      gap="sm"
      className="rounded-lg border border-[var(--border-chunky)] bg-muted/20 p-4"
    >
      <Row align="center" justify="between" gap="sm">
        <span className="font-medium text-sm">
          Review {suggestionCount} USDA suggestion
          {suggestionCount === 1 ? "" : "s"}
        </span>
        <Button
          size="sm"
          onClick={onCreate}
          disabled={isPending || creatableCount === 0}
        >
          Create {creatableCount} product
          {creatableCount === 1 ? "" : "s"}
        </Button>
      </Row>
      {progress && <Progress value={progress.done} max={progress.total} />}
      <Stack gap="sm">
        {Object.entries(suggestions).map(([id, sug]) => {
          const row = rows.find((r) => r.id === id);
          if (!row) return null;
          const p = suggestionPrices[id] ?? {
            dollars: "",
            qty: "1",
            unit: "lb",
          };
          return (
            <Row key={id} align="center" wrap gap="sm" className="text-sm">
              <button
                type="button"
                onClick={() => onReject(id)}
                aria-label={`Reject suggestion for ${row.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-4 w-4" />
              </button>
              <span className="font-medium">{row.name}</span>
              <span className="truncate text-muted-foreground">
                → {sug.food.foodInfo.description}
              </span>
              <span
                className={cn("text-2xs", confidenceColor[sug.confidence])}
                title={sug.reasoning}
              >
                {sug.confidence}
              </span>
              <Row
                as="span"
                align="center"
                gap="xs"
                className="ml-auto text-xs"
              >
                <span className="text-muted-foreground">$</span>
                <Input
                  value={p.dollars}
                  onChange={(e) =>
                    onPriceChange(id, { dollars: e.target.value })
                  }
                  placeholder="price"
                  aria-label={`Price for ${row.name}`}
                  className="h-7 w-16"
                />
                <span className="text-muted-foreground">/</span>
                <Input
                  value={p.qty}
                  onChange={(e) => onPriceChange(id, { qty: e.target.value })}
                  aria-label={`Price quantity for ${row.name}`}
                  className="h-7 w-12"
                />
                <UnitInput
                  value={p.unit}
                  onChange={(v) => onPriceChange(id, { unit: v })}
                  ariaLabel={`Price unit for ${row.name}`}
                />
              </Row>
            </Row>
          );
        })}
      </Stack>
      <Description size="2xs">
        Price optional — leave blank to create the USDA link and price later.
        Foods are usually priced by package (e.g. $5.99 / 2 lb); a unit of
        “each” stores a per-item price.
      </Description>
    </Stack>
  );
}

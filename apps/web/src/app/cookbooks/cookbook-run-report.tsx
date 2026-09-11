import type { CookbookRunReport } from "@cubby/schemas/cookbook";
import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";

import { recipe } from "~/app/recipes/recipe.functions";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { StatusText } from "~/components/ui/status-text";
import { getErrorMessage } from "~/lib/error-utils";

/** The handful of facts worth reading months after a book was extracted. */
export type RunReportSummary = {
  costUsd: number;
  costComplete: boolean;
  wallMs: number;
  models: { model: string; calls: number }[];
  recall: number | null;
  matched: number;
  navTitles: number;
  incomplete: boolean;
  cancelled: boolean;
};

export const summarizeRunReport = (
  report: CookbookRunReport,
): RunReportSummary => ({
  costUsd: report.total_cost_usd,
  costComplete: report.cost_complete,
  wallMs: report.wall_ms,
  models: report.usage_by_model.map((usage) => ({
    model: usage.model,
    calls: usage.calls,
  })),
  recall: report.crosscheck.recall ?? null,
  matched: report.crosscheck.matched,
  navTitles: report.crosscheck.nav_titles,
  incomplete: report.incomplete,
  cancelled: report.cancelled,
});

/**
 * What one extraction of this book cost and how complete it was.
 *
 * The full tree and report are large, so they are fetched only when this tab is
 * opened — the recipes tab, which is what almost every visit wants, never pays
 * for them. `incomplete` is the reason this panel exists at all: a book can
 * look finished in the recipes list while the run that produced it dropped
 * chunks, and the only record of that is here.
 */
export function CookbookRunReportPanel({
  cookbookId,
}: {
  cookbookId: CookbookShortcode;
}) {
  const { data, isLoading, error } = useQuery(
    recipe.getCookbookSource.queryOptions({ cookbookId }),
  );

  if (isLoading) {
    return (
      <Row align="center" gap="xs" className="text-sm text-muted-foreground">
        <Spinner className="size-3" /> Loading the stored extraction…
      </Row>
    );
  }
  if (error) {
    return (
      <StatusText as="p" tone="destructive" className="text-sm">
        {getErrorMessage(error)}
      </StatusText>
    );
  }
  if (!data?.report) {
    return (
      <Description size="sm">
        No run report is stored for this cookbook — it was imported before runs
        were recorded, or from a JSON export.
      </Description>
    );
  }

  const summary = summarizeRunReport(data.report);
  return (
    <Stack gap="sm">
      <Row wrap align="baseline" gap="sm">
        <span className="text-lg font-medium tabular-nums">
          ${summary.costUsd.toFixed(2)}
          {!summary.costComplete && "+"}
        </span>
        <Description as="span" size="sm">
          {Math.round(summary.wallMs / 1000)}s wall time · {summary.matched}/
          {summary.navTitles} contents titles matched
          {summary.recall != null &&
            ` · recall ${(summary.recall * 100).toFixed(0)}%`}
        </Description>
      </Row>
      {summary.models.length > 0 && (
        <Description size="sm">
          Models:{" "}
          {summary.models
            .map((usage) => `${usage.model} (${usage.calls})`)
            .join(", ")}
        </Description>
      )}
      {!summary.costComplete && (
        <Description size="xs">
          An unpriced model was used, so the real cost is higher than shown.
        </Description>
      )}
      {(summary.incomplete || summary.cancelled) && (
        <StatusText as="p" tone="warning" className="text-sm">
          {summary.cancelled
            ? "This run was cancelled — the book was only partly read."
            : "This run finished incomplete — some chunks failed every model, so recipes in them are missing. Re-extract from the EPUB to recover them."}
        </StatusText>
      )}
    </Stack>
  );
}

import type {
  ExpenseFilters,
  ExpenseFlowSankeyNode,
  ExpenseFlowSankeyOut,
} from "@cubby/schemas/project";
import type {
  DefaultLink,
  DefaultNode,
  SankeyLinkDatum,
  SankeyNodeDatum,
} from "@nivo/sankey";
import { FlowArrowIcon } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { expense } from "~/integrations/tanstack-query/generated/catalog/expense.gen";
import { nivoChartTheme, nivoMotion } from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/number-format";
import { ChartTooltip } from "~/ui/charts/chart-tooltip";
import { ResponsiveSankey } from "~/ui/charts/nivo-responsive";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

const COLUMN_COLOR = {
  funder: "var(--chart-6)",
  project: "var(--chart-1)",
  spendingCategory: "var(--chart-3)",
} satisfies Record<ExpenseFlowSankeyNode["column"], string>;
/** Grouped and unresolved buckets stay quiet beside named ones. */
const QUIET_BUCKETS = new Set([
  "funder:unknown",
  "project:none",
  "project:other",
  "spendingCategory:other",
  "spendingCategory:uncategorized",
  "spendingCategory:unclassified",
]);

const pathLabel = (
  path: ExpenseFlowSankeyOut["nonPositivePaths"][number],
  labels: ReadonlyMap<string, string>,
) =>
  [path.funder, path.project, path.category]
    .map((id) => labels.get(id) ?? id)
    .join(" → ");

/**
 * Historical funder → project → root Spending Category flow. Server paths
 * are net; only positive ones draw, so the non-positive remainder is listed
 * under the chart to keep the total honest.
 */
export function MoneyFlowSankey({
  filters,
  onOpenLedger,
}: {
  filters: ExpenseFilters;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const hydrated = useHydrated();
  const query = useQuery(expense.flowSankey.queryOptions(filters));
  const data = hydrated ? query.data : undefined;
  const visualization = visualizationState({
    data,
    isLoading: !hydrated || query.isLoading,
    error: hydrated ? query.error : null,
    empty: (data?.links.length ?? 0) === 0,
    onRetry: () => void query.refetch(),
  });
  const view = useMemo(() => {
    if (!data) return null;
    const linked = new Set(
      data.links.flatMap((link) => [link.source, link.target]),
    );
    const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
    const labels = new Map(data.nodes.map((node) => [node.id, node.label]));
    const topLinks = [...data.links]
      .filter((link) => link.source.startsWith("project:"))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
      .map(
        (link) =>
          `${labels.get(link.source)} to ${labels.get(link.target)} ${formatCurrency(link.value)}`,
      );
    return {
      nodeById,
      labels,
      chart: {
        nodes: data.nodes
          .filter((node) => linked.has(node.id))
          .map((node) => ({ id: node.id })),
        links: data.links.map(({ source, target, value }) => ({
          source,
          target,
          value,
        })),
      },
      linkFilter: new Map(
        data.links.map((link) => [
          `${link.source}\u0000${link.target}`,
          link.filter,
        ]),
      ),
      summary: `Money flow of ${formatCurrency(data.totals.linked)} from funders through projects to Spending Categories. Largest flows: ${topLinks.join("; ")}`,
    };
  }, [data]);

  const labels = view?.labels ?? new Map<string, string>();
  // Listed outside the chart's ready/empty state: a refund-only scope has no
  // positive link to draw but still has paths to reconcile.
  return (
    <div className="space-y-3">
      <Visualization
        state={visualization}
        icon={FlowArrowIcon}
        message="No positive money flow to chart."
        height={420}
      >
        {data && view ? (
          <figure aria-label={view.summary} className="space-y-3">
            <figcaption className="sr-only">{view.summary}.</figcaption>
            <div style={{ height: 420 }}>
              <ResponsiveSankey
                {...nivoMotion}
                data={view.chart}
                margin={{ top: 8, right: 168, bottom: 8, left: 168 }}
                align="justify"
                sort="descending"
                colors={(node) =>
                  QUIET_BUCKETS.has(node.id)
                    ? "var(--chart-neutral)"
                    : COLUMN_COLOR[
                        view.nodeById.get(node.id)?.column ?? "spendingCategory"
                      ]
                }
                nodeOpacity={1}
                nodeThickness={12}
                nodeSpacing={14}
                nodeBorderWidth={0}
                nodeBorderRadius={0}
                linkOpacity={0.3}
                linkHoverOpacity={0.55}
                linkHoverOthersOpacity={0.12}
                enableLinkGradient={false}
                label={(node) => view.labels.get(node.id) ?? node.id}
                labelPosition="outside"
                labelPadding={8}
                labelTextColor="var(--foreground)"
                theme={nivoChartTheme}
                valueFormat={(value) => formatCurrency(value)}
                onClick={(datum) => {
                  const filter =
                    "source" in datum
                      ? view.linkFilter.get(
                          `${datum.source.id}\u0000${datum.target.id}`,
                        )
                      : view.nodeById.get(datum.id)?.filter;
                  if (filter) onOpenLedger(filter);
                }}
                nodeTooltip={({
                  node,
                }: {
                  node: SankeyNodeDatum<DefaultNode, DefaultLink>;
                }) => (
                  <ChartTooltip>
                    <strong>{view.labels.get(node.id)}</strong> —{" "}
                    {formatCurrency(node.value)}
                  </ChartTooltip>
                )}
                linkTooltip={({
                  link,
                }: {
                  link: SankeyLinkDatum<DefaultNode, DefaultLink>;
                }) => (
                  <ChartTooltip>
                    {view.labels.get(link.source.id)} →{" "}
                    {view.labels.get(link.target.id)} —{" "}
                    <strong>{formatCurrency(link.value)}</strong>
                  </ChartTooltip>
                )}
              />
            </div>
          </figure>
        ) : null}
      </Visualization>
      {data && data.nonPositivePaths.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          <p>
            Not drawn: paths netting to zero or below, totalling{" "}
            {formatCurrency(data.totals.nonPositive, 2)}.
          </p>
          <ul className="mt-1 space-y-0.5 tabular-nums">
            {data.nonPositivePaths.map((path) => (
              <li key={`${path.funder}|${path.project}|${path.category}`}>
                {pathLabel(path, labels)} · {formatCurrency(path.net, 2)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

import type { PurchaseOut, Trade } from "@cubby/schemas/project";
import { ResponsiveTreeMap } from "@nivo/treemap";
import { sumBy } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { getCostTypeColor, TRADE_LABELS } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type TreeNode = {
  name: string;
  color?: string;
  value?: number;
  children?: TreeNode[];
};

export function CategoryTreemap({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo(() => {
    // Build cost type → trade → cost hierarchy
    const costTypes = new Map<string, Map<string, number>>();

    for (const p of purchases) {
      const costType = p.costType ?? "uncategorized";
      const trade = p.trade ?? "other";
      const cost = p.cost ?? 0;
      if (cost <= 0) continue;

      if (!costTypes.has(costType)) costTypes.set(costType, new Map());
      const trades = costTypes.get(costType)!;
      trades.set(trade, (trades.get(trade) ?? 0) + cost);
    }

    const children: TreeNode[] = Array.from(costTypes.entries())
      .map(([costType, trades]) => ({
        name: costType,
        color: getCostTypeColor(costType),
        children: Array.from(trades.entries())
          .map(([trade, value]) => ({
            name: TRADE_LABELS[trade as Trade] ?? trade,
            value,
          }))
          .sort((a, b) => b.value - a.value),
      }))
      .sort(
        (a, b) =>
          sumBy(b.children, (c) => c.value ?? 0) -
          sumBy(a.children, (c) => c.value ?? 0),
      );

    return { name: "root", children };
  }, [purchases]);

  if (!data.children || data.children.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No purchase data." />;
  }

  return (
    <div className="h-[400px]">
      <ResponsiveTreeMap
        data={data}
        identity="name"
        value="value"
        tile="squarify"
        innerPadding={3}
        outerPadding={3}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        label={(node) => {
          if (node.width < 60 || node.height < 30) return "";
          return node.id;
        }}
        parentLabel={(node) => {
          if (node.width < 80 || node.height < 20) return "";
          return node.id;
        }}
        parentLabelPosition="top"
        parentLabelPadding={6}
        parentLabelTextColor="var(--background)"
        labelTextColor="var(--background)"
        colors={(node) => {
          // pathComponents is [root, costType, trade] — use index 1 for the cost type
          const costType = node.pathComponents[1] ?? node.pathComponents[0];
          return getCostTypeColor(costType ?? null);
        }}
        borderWidth={2}
        borderColor="var(--card)"
        nodeOpacity={0.9}
        tooltip={({ node }) => (
          <ChartTooltip>
            <div className="flex items-center gap-2">
              <div
                className="h-3 w-3 rounded"
                style={{ backgroundColor: node.color }}
              />
              <strong>{node.id}</strong>
            </div>
            <div className="text-muted-foreground">
              {node.pathComponents.length > 1 && (
                <span>{node.pathComponents[0]} &gt; </span>
              )}
              {formatCurrency(node.value, 0)}
            </div>
          </ChartTooltip>
        )}
        theme={{
          labels: {
            text: { fontSize: 11, fontWeight: 500 },
          },
        }}
      />
    </div>
  );
}

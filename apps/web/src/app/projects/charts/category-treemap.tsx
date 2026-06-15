import { ResponsiveTreeMap } from "@nivo/treemap";
import { sumBy } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";
import { getCategoryColor } from "../shared";
import { ChartEmpty } from "./chart-empty";

type TreeNode = {
  name: string;
  color?: string;
  value?: number;
  children?: TreeNode[];
};

export function CategoryTreemap({
  purchases,
}: {
  purchases: NotionPurchase[];
}) {
  const data = useMemo(() => {
    // Build category → subcategory → cost hierarchy
    const categories = new Map<string, Map<string, number>>();

    for (const p of purchases) {
      const cat = p.category ?? "uncategorized";
      const sub = p.subcategory ?? "other";
      const cost = p.cost ?? 0;
      if (cost <= 0) continue;

      if (!categories.has(cat)) categories.set(cat, new Map());
      const subs = categories.get(cat)!;
      subs.set(sub, (subs.get(sub) ?? 0) + cost);
    }

    const children: TreeNode[] = Array.from(categories.entries())
      .map(([cat, subs]) => ({
        name: cat,
        color: getCategoryColor(cat),
        children: Array.from(subs.entries())
          .map(([sub, value]) => ({ name: sub, value }))
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
        parentLabelTextColor="white"
        labelTextColor="white"
        colors={(node) => {
          // pathComponents is [root, category, subcategory] — use index 1 for the category
          const category = node.pathComponents[1] ?? node.pathComponents[0];
          return getCategoryColor(category ?? null);
        }}
        borderWidth={2}
        borderColor="var(--card)"
        nodeOpacity={0.9}
        tooltip={({ node }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
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
          </div>
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

import { ResponsiveCalendar } from "@nivo/calendar";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";

export function SpendingHeatmap({
  purchases,
}: {
  purchases: NotionPurchase[];
}) {
  const { data, from, to } = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const p of purchases) {
      if (!p.date || !p.cost) continue;
      byDay.set(p.date, (byDay.get(p.date) ?? 0) + p.cost);
    }

    const data = Array.from(byDay.entries()).map(([day, value]) => ({
      day,
      value,
    }));

    if (data.length === 0) return { data: [], from: "", to: "" };

    const dates = data.map((d) => d.day).sort();
    return { data, from: dates[0], to: dates[dates.length - 1] };
  }, [purchases]);

  if (data.length === 0) {
    return <p className="text-muted-foreground text-sm">No dated purchases.</p>;
  }

  const yearSpan =
    new Date(to).getFullYear() - new Date(from).getFullYear() + 1;
  const chartHeight = Math.max(180, yearSpan * 160);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveCalendar
        data={data}
        from={from}
        to={to}
        emptyColor="#f0f0f0"
        colors={[
          "hsl(142, 40%, 80%)",
          "hsl(142, 45%, 65%)",
          "hsl(142, 50%, 50%)",
          "hsl(142, 55%, 35%)",
        ]}
        margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
        yearSpacing={40}
        monthBorderColor="#e0e0e0"
        dayBorderWidth={1}
        dayBorderColor="#ffffff"
        tooltip={({ day, value }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
            <strong>{day}</strong>: {formatCurrency(Number(value), 0)} spent
          </div>
        )}
        theme={{
          text: { fill: "#333" },
          labels: { text: { fill: "#666", fontSize: 11 } },
        }}
      />
    </div>
  );
}

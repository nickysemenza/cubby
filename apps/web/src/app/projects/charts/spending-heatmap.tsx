import { ResponsiveCalendar } from "@nivo/calendar";
import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";
import { formatDate } from "../shared";
import { ChartEmpty } from "./chart-empty";

export function SpendingHeatmap({
  purchases,
}: {
  purchases: NotionPurchase[];
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const { data, from, to, itemsByDay } = useMemo(() => {
    const byDay = new Map<string, number>();
    const itemsByDay = new Map<string, NotionPurchase[]>();
    for (const p of purchases) {
      if (!p.date || !p.cost) continue;
      byDay.set(p.date, (byDay.get(p.date) ?? 0) + p.cost);
      if (!itemsByDay.has(p.date)) itemsByDay.set(p.date, []);
      itemsByDay.get(p.date)!.push(p);
    }

    const data = Array.from(byDay.entries()).map(([day, value]) => ({
      day,
      value,
    }));

    if (data.length === 0)
      return { data: [], from: "", to: "", itemsByDay: new Map() };

    const dates = data.map((d) => d.day).sort();
    return {
      data,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      itemsByDay,
    };
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarDays} title="No dated purchases." />;
  }

  const yearSpan =
    new Date(to).getFullYear() - new Date(from).getFullYear() + 1;
  const chartHeight = Math.max(180, yearSpan * 160);
  const selectedItems: NotionPurchase[] = selectedDay
    ? (itemsByDay.get(selectedDay) ?? [])
    : [];

  return (
    <div className="space-y-2">
      <div style={{ height: chartHeight }}>
        <ResponsiveCalendar
          data={data}
          from={from}
          to={to}
          emptyColor="var(--muted)"
          colors={[
            "var(--chart-seq-2)",
            "var(--chart-seq-3)",
            "var(--chart-seq-4)",
            "var(--chart-seq-5)",
          ]}
          margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
          yearSpacing={40}
          monthBorderColor="var(--border)"
          dayBorderWidth={1}
          dayBorderColor="var(--card)"
          onClick={(day) => {
            if ("value" in day && day.value) {
              setSelectedDay(selectedDay === day.day ? null : day.day);
            }
          }}
          tooltip={({ day, value }) => (
            <div className="rounded-md bg-popover px-4 py-2 text-sm shadow-md ring-1 ring-border">
              <strong>{day}</strong>: {formatCurrency(Number(value), 0)} spent
              <div className="text-muted-foreground text-xs">
                Click to see items
              </div>
            </div>
          )}
          theme={{
            text: { fill: "var(--foreground)" },
            labels: { text: { fill: "var(--muted-foreground)", fontSize: 11 } },
          }}
        />
      </div>
      {selectedDay && selectedItems.length > 0 && (
        <div className="rounded-md border border-[var(--border-chunky)] bg-muted/30 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-sm">
              {formatDate(selectedDay)} —{" "}
              {formatCurrency(
                selectedItems.reduce(
                  (s: number, p: NotionPurchase) => s + (p.cost ?? 0),
                  0,
                ),
                0,
              )}
            </span>
            <button
              type="button"
              onClick={() => setSelectedDay(null)}
              className="text-muted-foreground text-xs hover:text-foreground"
            >
              Close
            </button>
          </div>
          <div className="space-y-1">
            {selectedItems.map((p) => (
              <a
                key={p.id}
                href={p.notionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
              >
                <span className="truncate">{p.name}</span>
                <div className="flex shrink-0 items-center gap-2">
                  {p.projectName && (
                    <span className="text-muted-foreground">
                      {p.projectName}
                    </span>
                  )}
                  {p.cost != null && (
                    <span className="font-medium">
                      {formatCurrency(p.cost, 0)}
                    </span>
                  )}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

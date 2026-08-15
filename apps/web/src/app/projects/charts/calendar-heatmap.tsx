import { ResponsiveCalendar } from "@nivo/calendar";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { nivoMotion } from "~/lib/nivo-theme";

interface CalendarHeatmapProps<T> {
  data: Array<{ day: string; value: number }>;
  from: string;
  to: string;
  itemsByDay: Map<string, T[]>;
  tooltip: NonNullable<ComponentProps<typeof ResponsiveCalendar>["tooltip"]>;
  summary: (day: string, items: T[]) => ReactNode;
  renderItem: (item: T) => ReactNode;
}

/** Shared calendar chrome and selected-day panel for project heatmaps. */
export function CalendarHeatmap<T>({
  data,
  from,
  to,
  itemsByDay,
  tooltip,
  summary,
  renderItem,
}: CalendarHeatmapProps<T>) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const selectedItems = selectedDay ? (itemsByDay.get(selectedDay) ?? []) : [];
  const yearSpan =
    new Date(to).getFullYear() - new Date(from).getFullYear() + 1;

  return (
    <div className="space-y-2">
      <div style={{ height: Math.max(180, yearSpan * 160) }}>
        <ResponsiveCalendar
          {...nivoMotion}
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
          tooltip={tooltip}
          theme={{
            text: { fill: "var(--foreground)" },
            labels: { text: { fill: "var(--muted-foreground)", fontSize: 11 } },
          }}
        />
      </div>
      {selectedDay && selectedItems.length > 0 && (
        <div className="border border-[var(--border)] bg-muted/30 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-sm">
              {summary(selectedDay, selectedItems)}
            </span>
            <button
              type="button"
              onClick={() => setSelectedDay(null)}
              className="text-muted-foreground text-xs hover:text-foreground"
            >
              Close
            </button>
          </div>
          <div className="space-y-1">{selectedItems.map(renderItem)}</div>
        </div>
      )}
    </div>
  );
}

import { ResponsiveCalendar } from "@nivo/calendar";
import { CalendarClock } from "lucide-react";
import { useMemo, useState } from "react";
import type { NotionTask } from "~/server/clients/notion";
import { formatDate, StatusIcon } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

export function TaskHeatmap({ tasks }: { tasks: NotionTask[] }) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const { data, from, to, itemsByDay } = useMemo(() => {
    const byDay = new Map<string, number>();
    const itemsByDay = new Map<string, NotionTask[]>();
    for (const t of tasks) {
      if (!t.due) continue;
      byDay.set(t.due, (byDay.get(t.due) ?? 0) + 1);
      if (!itemsByDay.has(t.due)) itemsByDay.set(t.due, []);
      itemsByDay.get(t.due)!.push(t);
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
  }, [tasks]);

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarClock} title="No tasks with due dates." />;
  }

  const yearSpan =
    new Date(to).getFullYear() - new Date(from).getFullYear() + 1;
  const chartHeight = Math.max(180, yearSpan * 160);
  const selectedItems: NotionTask[] = selectedDay
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
            <ChartTooltip>
              <strong>{day}</strong>: {value} task
              {Number(value) !== 1 ? "s" : ""} due
              <div className="text-muted-foreground text-xs">
                Click to see tasks
              </div>
            </ChartTooltip>
          )}
          theme={{
            text: { fill: "var(--foreground)" },
            labels: { text: { fill: "var(--muted-foreground)", fontSize: 11 } },
          }}
        />
      </div>
      {selectedDay && selectedItems.length > 0 && (
        <div className="rounded-md border border-[var(--border)] bg-muted/30 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-sm">
              {formatDate(selectedDay)} — {selectedItems.length} task
              {selectedItems.length !== 1 ? "s" : ""}
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
            {selectedItems.map((t) => (
              <a
                key={t.id}
                href={t.notionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
              >
                <StatusIcon status={t.status} />
                <span className="truncate">{t.name}</span>
                {t.projectName && (
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {t.projectName}
                  </span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

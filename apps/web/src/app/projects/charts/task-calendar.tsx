import { ResponsiveCalendar } from "@nivo/calendar";
import { useMemo } from "react";
import type { NotionTask } from "~/server/clients/notion";

export function TaskCalendar({ tasks }: { tasks: NotionTask[] }) {
  const { data, from, to } = useMemo(() => {
    // Count tasks by due date
    const counts = new Map<string, number>();
    for (const t of tasks) {
      if (!t.due) continue;
      counts.set(t.due, (counts.get(t.due) ?? 0) + 1);
    }

    const data = Array.from(counts.entries()).map(([day, value]) => ({
      day,
      value,
    }));

    if (data.length === 0) return { data: [], from: "", to: "" };

    // Find date range
    const dates = data.map((d) => d.day).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];

    return { data, from, to };
  }, [tasks]);

  if (data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No tasks with due dates.</p>
    );
  }

  // Calculate height based on year span
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
          "hsl(210, 50%, 80%)",
          "hsl(210, 55%, 65%)",
          "hsl(210, 60%, 50%)",
          "hsl(210, 65%, 35%)",
        ]}
        margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
        yearSpacing={40}
        monthBorderColor="#e0e0e0"
        dayBorderWidth={1}
        dayBorderColor="#ffffff"
        tooltip={({ day, value }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
            <strong>{day}</strong>: {value} task{Number(value) !== 1 ? "s" : ""}{" "}
            due
          </div>
        )}
        theme={{
          text: { fill: "#333" },
          labels: {
            text: { fill: "#666", fontSize: 11 },
          },
        }}
      />
    </div>
  );
}

import { useMemo, useRef } from "react";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import type { NotionProject } from "~/server/clients/notion";
import { formatDate } from "../shared";

const STATUS_COLORS: Record<string, string> = {
  Done: "hsl(142, 50%, 50%)",
  "In progress": "hsl(210, 60%, 55%)",
  Planning: "hsl(270, 50%, 60%)",
  "Not started": "#999",
};

export function ProjectTimeline({ projects }: { projects: NotionProject[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width } = useContainerDimensions(containerRef, {
    minHeight: 100,
    initialWidth: 800,
  });

  const { items, minDate, maxDate } = useMemo(() => {
    const dated = projects
      .filter((p) => p.date && p.dateEnd)
      .map((p) => ({
        ...p,
        start: new Date(p.date!),
        end: new Date(p.dateEnd!),
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    if (dated.length === 0)
      return { items: [], minDate: new Date(), maxDate: new Date() };

    const allDates = dated.flatMap((d) => [d.start, d.end]);
    const minDate = new Date(Math.min(...allDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...allDates.map((d) => d.getTime())));

    // Add padding
    minDate.setDate(minDate.getDate() - 7);
    maxDate.setDate(maxDate.getDate() + 7);

    return { items: dated, minDate, maxDate };
  }, [projects]);

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No projects with dates.</p>
    );
  }

  const marginLeft = 160;
  const marginRight = 20;
  const marginTop = 30;
  const barHeight = 24;
  const barGap = 8;
  const chartWidth = width - marginLeft - marginRight;
  const chartHeight = marginTop + items.length * (barHeight + barGap) + 20;

  const timeRange = maxDate.getTime() - minDate.getTime();
  const toX = (date: Date) =>
    marginLeft +
    ((date.getTime() - minDate.getTime()) / timeRange) * chartWidth;

  // Generate month tick marks, skip months if too dense
  const totalMonths =
    (maxDate.getFullYear() - minDate.getFullYear()) * 12 +
    (maxDate.getMonth() - minDate.getMonth());
  const monthStep = totalMonths > 24 ? 3 : totalMonths > 12 ? 2 : 1;

  const ticks: { x: number; label: string }[] = [];
  const cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  let monthIndex = 0;
  while (cursor <= maxDate) {
    if (monthIndex % monthStep === 0) {
      ticks.push({
        x: toX(cursor),
        label: cursor.toLocaleDateString("en-US", {
          month: "short",
          year: "2-digit",
        }),
      });
    }
    cursor.setMonth(cursor.getMonth() + 1);
    monthIndex++;
  }

  return (
    <div ref={containerRef} className="overflow-x-auto">
      <svg width={width} height={chartHeight}>
        {/* Grid lines */}
        {ticks.map((tick) => (
          <g key={tick.label}>
            <line
              x1={tick.x}
              y1={marginTop - 5}
              x2={tick.x}
              y2={chartHeight - 10}
              stroke="#e5e5e5"
              strokeWidth={1}
            />
            <text
              x={tick.x}
              y={marginTop - 10}
              textAnchor="middle"
              fontSize={11}
              fill="#666"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Bars */}
        {items.map((item, i) => {
          const y = marginTop + i * (barHeight + barGap);
          const x1 = toX(item.start);
          const x2 = toX(item.end);
          const barW = Math.max(x2 - x1, 4);
          const color = STATUS_COLORS[item.status ?? ""] ?? "#999";

          return (
            <g key={item.id}>
              {/* Project name */}
              <text
                x={marginLeft - 8}
                y={y + barHeight / 2}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={12}
                fill="#333"
              >
                {item.name.length > 20
                  ? `${item.name.slice(0, 20)}...`
                  : item.name}
              </text>
              {/* Bar */}
              <rect
                x={x1}
                y={y}
                width={barW}
                height={barHeight}
                rx={4}
                fill={color}
                opacity={0.85}
              >
                <title>
                  {item.name}: {formatDate(item.date!)}
                  {item.dateEnd ? ` — ${formatDate(item.dateEnd)}` : ""}
                  {` (${item.status})`}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

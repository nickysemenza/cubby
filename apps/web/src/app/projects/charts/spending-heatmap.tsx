import type { PurchaseOut } from "@cubby/schemas/project";
import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { formatDate } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { CalendarHeatmap } from "./calendar-heatmap";
import { ChartEmpty } from "./chart-empty";
import { buildPurchaseCalendar } from "./project-chart-data";

export function SpendingHeatmap({ purchases }: { purchases: PurchaseOut[] }) {
  const { data, from, to, itemsByDay } = useMemo(
    () => buildPurchaseCalendar(purchases),
    [purchases],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarDays} title="No dated purchases." />;
  }

  return (
    <CalendarHeatmap
      data={data}
      from={from}
      to={to}
      itemsByDay={itemsByDay}
      tooltip={({ day, value }) => (
        <ChartTooltip>
          <strong>{day}</strong>: {formatCurrency(Number(value), 0)} spent
          <div className="text-muted-foreground text-xs">
            Click to see items
          </div>
        </ChartTooltip>
      )}
      summary={(day, items) => (
        <>
          {formatDate(day)} —{" "}
          {formatCurrency(
            items.reduce((total, purchase) => total + (purchase.cost ?? 0), 0),
            0,
          )}
        </>
      )}
      renderItem={(purchase) => (
        <a
          key={purchase.id}
          href={purchase.url ?? undefined}
          target={purchase.url ? "_blank" : undefined}
          rel={purchase.url ? "noopener noreferrer" : undefined}
          className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
        >
          <span className="truncate">{purchase.name}</span>
          <div className="flex shrink-0 items-center gap-2">
            {purchase.projectName && (
              <span className="text-muted-foreground">
                {purchase.projectName}
              </span>
            )}
            {purchase.cost != null && (
              <span className="font-medium">
                {formatCurrency(purchase.cost, 0)}
              </span>
            )}
          </div>
        </a>
      )}
    />
  );
}

import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { CalendarCheckIcon as CalendarClock } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { useMemo } from "react";

import { monthLabel } from "../shared";
import { ChartEmpty } from "./chart-empty";
import {
  PlannedActualBar,
  type PlannedActualDatum,
} from "./planned-actual-bar";

/** Portfolio committed vs actual spend, grouped by month. */
export function PlannedVsActualByMonth({
  data: rows,
}: {
  data: ProjectPortfolioAnalyticsOut["plannedVsActual"];
}) {
  const data = useMemo(
    () =>
      rows
        .map((row): PlannedActualDatum => ({
          category: monthLabel(row.month),
          actual: row.actual,
          planned: row.planned,
        }))
        .filter((datum) => datum.actual > 0 || datum.planned > 0),
    [rows],
  );

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarClock} title="No expense data." />;
  }

  return <PlannedActualBar data={data} />;
}

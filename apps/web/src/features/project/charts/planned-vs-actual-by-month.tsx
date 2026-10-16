import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { useMemo } from "react";

import { Visualization } from "~/ui/visualizations/visualization";

import { monthLabel } from "../project-formatting";
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
    return (
      <Visualization
        state={{ status: "empty" }}
        icon={CalendarCheckIcon}
        message="No expense data."
      />
    );
  }

  return <PlannedActualBar data={data} />;
}

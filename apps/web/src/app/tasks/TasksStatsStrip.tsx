import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { DrilldownMetricStrip } from "~/components/ui/drilldown-metric-strip";

import { task } from "./task.functions";

const route = getRouteApi("/_authenticated/tasks/");

/**
 * Compact counts strip above the Tasks page's `ViewSwitcher` — backed by the
 * cheap `task.summary` read (server-computed counts) rather than a
 * fetch-everything `chartData` reduced client-side. Each tile links to the
 * view that surfaces those tasks.
 */
export function TasksStatsStrip() {
  const navigate = route.useNavigate();
  const { data, isLoading } = useQuery(task.summary.queryOptions());

  if (isLoading || !data) return <DrilldownMetricStrip loadingCount={7} />;

  const goToNext = () =>
    navigate({ search: (prev) => ({ ...prev, view: "next" }) });
  const goToInbox = () =>
    navigate({
      search: (prev) => ({
        ...prev,
        view: "list",
        q: undefined,
        status: "not_started,later,in_progress,blocked",
        project: "__none__",
        parentTask: "__none__",
        dueDate: undefined,
        trade: undefined,
        subjectProduct: undefined,
        productId: undefined,
      }),
    });

  return (
    <DrilldownMetricStrip
      metrics={[
        { label: "Total open", value: data.totalOpen, onSelect: goToNext },
        { label: "Next", value: data.next, onSelect: goToNext },
        { label: "Someday", value: data.later, onSelect: goToNext },
        { label: "Inbox", value: data.inbox, onSelect: goToInbox },
        { label: "Overdue", value: data.overdue, onSelect: goToNext },
        {
          label: "Due in 7 days",
          value: data.dueThisWeek,
          onSelect: goToNext,
        },
        { label: "Blocked", value: data.blocked, onSelect: goToNext },
      ]}
    />
  );
}

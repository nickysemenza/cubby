import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Grid } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { StatTile } from "~/components/ui/stat-tile";
import { useTRPC } from "~/integrations/trpc/react";

const route = getRouteApi("/_authenticated/tasks/");

const SKELETON_TILES = [
  "total",
  "next",
  "later",
  "inbox",
  "overdue",
  "week",
  "blocked",
] as const;

function StatsSkeleton() {
  return (
    <Grid cols="summary">
      {SKELETON_TILES.map((key) => (
        <Skeleton key={key} className="h-14 w-full" />
      ))}
    </Grid>
  );
}

/**
 * One clickable stat — navigates (merge, not replace, so `q`/table-search
 * params survive) to the view that surfaces the underlying tasks.
 */
function StatLink({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left transition-colors hover:text-foreground"
    >
      <StatTile label={label}>{value}</StatTile>
    </button>
  );
}

/**
 * Compact counts strip above the Tasks page's `ViewSwitcher` — backed by the
 * cheap `task.summary` read (server-computed counts) rather than a
 * fetch-everything `chartData` reduced client-side. Each tile links to the
 * view that surfaces those tasks.
 */
export function TasksStatsStrip() {
  const api = useTRPC();
  const navigate = route.useNavigate();
  const { data, isLoading } = useQuery(api.task.summary.queryOptions());

  if (isLoading || !data) return <StatsSkeleton />;

  const goTo = (view: "next" | "inbox") =>
    navigate({ search: (prev) => ({ ...prev, view }) });

  return (
    <Grid cols="summary">
      <StatLink
        label="Total open"
        value={data.totalOpen}
        onClick={() => goTo("next")}
      />
      <StatLink label="Next" value={data.next} onClick={() => goTo("next")} />
      <StatLink
        label="Someday"
        value={data.later}
        onClick={() => goTo("next")}
      />
      <StatLink
        label="Inbox"
        value={data.inbox}
        onClick={() => goTo("inbox")}
      />
      <StatLink
        label="Overdue"
        value={data.overdue}
        onClick={() => goTo("next")}
      />
      <StatLink
        label="Due this week"
        value={data.dueThisWeek}
        onClick={() => goTo("next")}
      />
      <StatLink
        label="Blocked"
        value={data.blocked}
        onClick={() => goTo("next")}
      />
    </Grid>
  );
}

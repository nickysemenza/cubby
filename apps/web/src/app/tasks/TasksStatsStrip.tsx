import type { TaskOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { endOfWeek, format, startOfWeek } from "date-fns";
import { useMemo } from "react";
import { Grid } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { StatTile } from "~/components/ui/stat-tile";
import { useTRPC } from "~/integrations/trpc/react";

/** Stable empty default — never a fresh `[]` per render (would churn memos). */
const NO_TASKS: TaskOut[] = [];

interface TaskStats {
  /** Non-done tasks. */
  totalOpen: number;
  /** Non-done tasks whose effective due date (`dueEndDate ?? dueDate`) is
   * before today. */
  overdue: number;
  /** Non-done tasks whose effective due date falls within this calendar
   * week (local time). */
  dueThisWeek: number;
  /** `status === "blocked"`, regardless of due date. */
  blocked: number;
}

/**
 * Plain "YYYY-MM-DD" strings sort chronologically as strings — same trick
 * `resolveDueRange` (task-options.ts) uses for the due-date filter — so this
 * needs no Date parsing at all.
 */
function computeTaskStats(tasks: TaskOut[]): TaskStats {
  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");
  const weekFromStr = format(startOfWeek(today), "yyyy-MM-dd");
  const weekToStr = format(endOfWeek(today), "yyyy-MM-dd");

  let totalOpen = 0;
  let overdue = 0;
  let dueThisWeek = 0;
  let blocked = 0;

  for (const task of tasks) {
    const isDone = task.status === "done";
    if (!isDone) totalOpen++;
    if (task.status === "blocked") blocked++;

    if (isDone) continue;
    const effectiveDue = task.dueEndDate ?? task.dueDate;
    if (effectiveDue == null) continue;
    if (effectiveDue < todayStr) overdue++;
    else if (effectiveDue >= weekFromStr && effectiveDue <= weekToStr)
      dueThisWeek++;
  }

  return { totalOpen, overdue, dueThisWeek, blocked };
}

const SKELETON_TILES = ["total", "overdue", "week", "blocked"] as const;

function StatsSkeleton() {
  return (
    <Grid cols="summary">
      {SKELETON_TILES.map((key) => (
        <Skeleton key={key} className="h-14 w-full" />
      ))}
    </Grid>
  );
}

/** Compact counts strip above the Tasks page's `ViewSwitcher` — the same
 * fetch-all `chartData` query the board and timeline use, so it's already
 * warm from cache on most visits. */
export function TasksStatsStrip() {
  const api = useTRPC();
  const { data: tasks = NO_TASKS, isLoading } = useQuery(
    api.task.chartData.queryOptions({}),
  );
  const stats = useMemo(() => computeTaskStats(tasks), [tasks]);

  if (isLoading) return <StatsSkeleton />;

  return (
    <Grid cols="summary">
      <StatTile label="Total open">{stats.totalOpen}</StatTile>
      <StatTile label="Overdue">{stats.overdue}</StatTile>
      <StatTile label="Due this week">{stats.dueThisWeek}</StatTile>
      <StatTile label="Blocked">{stats.blocked}</StatTile>
    </Grid>
  );
}

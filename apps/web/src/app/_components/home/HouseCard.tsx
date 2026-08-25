import type { TaskSummaryOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Hammer } from "lucide-react";
import { taskSummaryQueryOptions } from "~/app/tasks/task.functions";
import { Grid } from "~/components/layout";
import {
  CardActionLink,
  DashboardCard,
} from "~/components/layout/dashboard-card";
import { Skeleton } from "~/components/ui/skeleton";
import { StatTile } from "~/components/ui/stat-tile";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";

/** The Tasks page views each stat drills into — same mapping the /tasks stats
 * strip uses (Next surfaces overdue/due-soon/blocked work; Inbox is the
 * project-less pile). */
type TaskView = "next" | "inbox";

interface HouseStat {
  key: keyof TaskSummaryOut;
  label: string;
  view: TaskView;
  /** Overdue is the one count worth a tone — everything else stays neutral. */
  tone?: "destructive";
}

const STATS: HouseStat[] = [
  { key: "overdue", label: "Overdue", view: "next", tone: "destructive" },
  { key: "dueThisWeek", label: "Due in 7 days", view: "next" },
  { key: "inbox", label: "Inbox", view: "inbox" },
  { key: "blocked", label: "Blocked", view: "next" },
];

function useTaskSummary() {
  const session = authClient.useSession();
  // Hydration-gated auth (see useHydrated): keeps SSR and the first client
  // render identical, and stops the query firing Unauthorized while the
  // session resolves.
  const isAuthenticated = useHydrated() && !!session.data?.user;
  return useQuery({
    ...taskSummaryQueryOptions(),
    enabled: isAuthenticated,
  });
}

/**
 * Home-page House tile: the four house-tracker counts worth acting on, backed
 * by the cheap server-computed `task.summary` read (not a fetch-everything
 * list). Each stat drills into the Tasks view that surfaces it; the header
 * links through to Projects.
 */
export function HouseCard() {
  const { data, isLoading } = useTaskSummary();

  return (
    <DashboardCard
      icon={Hammer}
      title="House"
      description="Open work across the house tracker"
      action={<CardActionLink to="/projects">Projects</CardActionLink>}
    >
      <Grid cols="summary" gap="sm">
        {STATS.map((stat) => (
          <Link
            key={stat.key}
            to="/tasks"
            search={
              stat.view === "inbox"
                ? {
                    view: "list",
                    status: "not_started,later,in_progress,blocked",
                    project: "__none__",
                    parentTask: "__none__",
                  }
                : { view: "next" }
            }
            className="min-h-11 transition-colors hover:bg-muted/50"
          >
            <StatTile label={stat.label}>
              {isLoading || !data ? (
                <Skeleton className="h-6 w-10" />
              ) : (
                <span
                  className={
                    stat.tone === "destructive" && data[stat.key] > 0
                      ? "text-destructive"
                      : undefined
                  }
                >
                  {data[stat.key]}
                </span>
              )}
            </StatTile>
          </Link>
        ))}
      </Grid>
    </DashboardCard>
  );
}

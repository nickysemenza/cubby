import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Calendar, DollarSign, ExternalLink, Hammer } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { formatCurrency } from "~/lib/utils";
import type {
  NotionProject,
  NotionPurchase,
  NotionTask,
} from "~/server/clients/notion";
import { useTRPC } from "~/trpc/react";
import { formatDateRange, PurchaseList, StatusIcon, TaskList } from "./shared";

export function ProjectsDashboard() {
  const api = useTRPC();
  const { data, isLoading } = useQuery({
    ...api.notion.dashboard.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <h1 className="font-bold font-heading text-3xl">Projects</h1>
        <Card>
          <CardContent>
            <p className="text-muted-foreground">
              Notion integration is not configured. Add{" "}
              <code className="rounded bg-muted px-1 text-sm">
                NOTION_API_KEY
              </code>{" "}
              to your environment variables.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { projects, tasks, purchases } = data;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <Hammer className="h-8 w-8" />
        <h1 className="font-bold font-heading text-3xl">Projects</h1>
      </div>

      <SummaryCards projects={projects} tasks={tasks} purchases={purchases} />

      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">Active Projects</h2>
        <ProjectCards projects={projects} />
      </section>

      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">Tasks</h2>
        <TaskList tasks={tasks} />
      </section>

      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">Recent Purchases</h2>
        <PurchaseList purchases={purchases} />
      </section>
    </div>
  );
}

// -- Summary Cards --

function SummaryCards({
  projects,
  tasks,
  purchases,
}: {
  projects: NotionProject[];
  tasks: NotionTask[];
  purchases: NotionPurchase[];
}) {
  const activeProjects = projects.filter((p) => p.status !== "Done").length;
  const activeTasks = tasks.filter((t) => t.status !== "Done").length;
  const totalSpend = purchases.reduce((sum, p) => sum + (p.cost ?? 0), 0);

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card size="sm">
        <CardHeader>
          <CardDescription>Active Projects</CardDescription>
          <CardTitle className="text-2xl">{activeProjects}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {statusCounts(projects.map((p) => p.status)).map(
              ([status, count]) => (
                <Badge key={status} variant="outline">
                  {status}: {count}
                </Badge>
              ),
            )}
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Active Tasks</CardDescription>
          <CardTitle className="text-2xl">{activeTasks}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {statusCounts(tasks.map((t) => t.status)).map(([status, count]) => (
              <Badge key={status} variant="outline">
                {status}: {count}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Total Spend</CardDescription>
          <CardTitle className="text-2xl">
            {formatCurrency(totalSpend, 0)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-xs">
            {purchases.length} purchases
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function statusCounts(statuses: (string | null)[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const s of statuses) {
    const key = s ?? "Unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries());
}

// -- Project Cards --

function ProjectCards({ projects }: { projects: NotionProject[] }) {
  const active = projects.filter((p) => p.status !== "Done");
  const done = projects.filter((p) => p.status === "Done");

  if (active.length === 0 && done.length === 0) {
    return <p className="text-muted-foreground text-sm">No projects found.</p>;
  }

  return (
    <div className="space-y-6">
      {active.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground text-sm hover:text-foreground">
            Completed ({done.length})
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {done.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: NotionProject }) {
  return (
    <Link to="/projects/$id" params={{ id: project.id }} className="block">
      <Card size="sm" className="transition-colors hover:bg-muted/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="truncate">{project.name}</span>
            <a
              href={project.notionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          </CardTitle>
          <CardDescription className="flex items-center gap-2">
            <StatusIcon status={project.status} />
            {project.status ?? "No status"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {project.kind && <Badge variant="secondary">{project.kind}</Badge>}
            {project.location.map((loc) => (
              <Badge key={loc} variant="outline">
                {loc}
              </Badge>
            ))}
            {project.costEstimate != null && (
              <Badge variant="outline">
                <DollarSign className="h-3 w-3" />
                {formatCurrency(project.costEstimate, 0)}
              </Badge>
            )}
            {(project.date || project.dateEnd) && (
              <Badge variant="outline">
                <Calendar className="h-3 w-3" />
                {formatDateRange(project.date, project.dateEnd)}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

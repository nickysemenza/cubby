import { useQuery } from "@tanstack/react-query";
import {
  Calendar,
  CheckCircle2,
  Circle,
  Clock,
  DollarSign,
  ExternalLink,
  Hammer,
  ListTodo,
  ShieldAlert,
  ShoppingCart,
} from "lucide-react";
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

export function ProjectsDashboard() {
  const api = useTRPC();
  const { data, isLoading } = useQuery(api.notion.dashboard.queryOptions());

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
    <a
      href={project.notionUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
    >
      <Card size="sm" className="transition-colors hover:bg-muted/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="truncate">{project.name}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
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
            {project.date && (
              <Badge variant="outline">
                <Calendar className="h-3 w-3" />
                {formatDate(project.date)}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </a>
  );
}

// -- Task List --

function TaskList({ tasks }: { tasks: NotionTask[] }) {
  const active = tasks
    .filter((t) => t.status !== "Done")
    .sort((a, b) => {
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
  const done = tasks.filter((t) => t.status === "Done");

  if (active.length === 0 && done.length === 0) {
    return <p className="text-muted-foreground text-sm">No tasks found.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {active.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>
      {done.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground text-sm hover:text-foreground">
            Completed ({done.length})
          </summary>
          <div className="mt-2 space-y-1">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: NotionTask }) {
  return (
    <a
      href={task.notionUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted/50"
    >
      <StatusIcon status={task.status} />
      <span className="min-w-0 flex-1 truncate">{task.name}</span>
      {task.projectName && (
        <Badge variant="secondary" className="shrink-0">
          {task.projectName}
        </Badge>
      )}
      {task.category && (
        <Badge variant="outline" className="shrink-0">
          {task.category}
        </Badge>
      )}
      {task.due && (
        <span className="shrink-0 text-muted-foreground text-xs">
          {formatDate(task.due)}
        </span>
      )}
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

// -- Purchase List --

function PurchaseList({ purchases }: { purchases: NotionPurchase[] }) {
  if (purchases.length === 0) {
    return <p className="text-muted-foreground text-sm">No purchases found.</p>;
  }

  return (
    <div className="space-y-1">
      {purchases.map((purchase) => (
        <PurchaseRow key={purchase.id} purchase={purchase} />
      ))}
    </div>
  );
}

function PurchaseRow({ purchase }: { purchase: NotionPurchase }) {
  return (
    <a
      href={purchase.notionUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted/50"
    >
      <ShoppingCart className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{purchase.name}</span>
      {purchase.projectName && (
        <Badge variant="secondary" className="shrink-0">
          {purchase.projectName}
        </Badge>
      )}
      {purchase.category && (
        <Badge variant="outline" className="shrink-0">
          {purchase.category}
        </Badge>
      )}
      {purchase.cost != null && (
        <span className="shrink-0 font-medium">
          {formatCurrency(purchase.cost, 0)}
        </span>
      )}
      {purchase.date && (
        <span className="shrink-0 text-muted-foreground text-xs">
          {formatDate(purchase.date)}
        </span>
      )}
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

// -- Helpers --

function StatusIcon({ status }: { status: string | null }) {
  switch (status) {
    case "Done":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />;
    case "In progress":
      return <Clock className="h-4 w-4 shrink-0 text-blue-500" />;
    case "Blocked":
      return <ShieldAlert className="h-4 w-4 shrink-0 text-red-500" />;
    case "Planning":
      return <ListTodo className="h-4 w-4 shrink-0 text-purple-500" />;
    default:
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { partition, sumBy, uniq } from "es-toolkit";
import { Calendar, DollarSign, ExternalLink, Hammer } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Image } from "~/components/ui/image";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { formatCurrency } from "~/lib/utils";
import type {
  NotionProject,
  NotionPurchase,
  NotionTask,
} from "~/server/clients/notion";
import { useTRPC } from "~/trpc/react";

import {
  DashboardFilters,
  emptyFilters,
  type Filters,
} from "./dashboard-filters";
import { NeedsAttention } from "./needs-attention";
import {
  formatDateRange,
  ProjectTable,
  PurchaseList,
  StatusIcon,
  TaskList,
} from "./shared";

// Charts are Nivo/d3-heavy and each tab's panel is unmounted until selected, so
// lazy-load them to keep their code out of the dashboard chunk until a tab opens.
const BudgetHealth = lazy(() =>
  import("./charts/budget-health").then((m) => ({ default: m.BudgetHealth })),
);
const CostVsEstimate = lazy(() =>
  import("./charts/cost-vs-estimate").then((m) => ({
    default: m.CostVsEstimate,
  })),
);
const DependencyGraph = lazy(() =>
  import("./charts/dependency-graph").then((m) => ({
    default: m.DependencyGraph,
  })),
);
const MonthlyTrend = lazy(() =>
  import("./charts/monthly-trend").then((m) => ({ default: m.MonthlyTrend })),
);
const ProjectTimeline = lazy(() =>
  import("./charts/project-timeline").then((m) => ({
    default: m.ProjectTimeline,
  })),
);
const PurchaseDonut = lazy(() =>
  import("./charts/purchase-donut").then((m) => ({ default: m.PurchaseDonut })),
);
const SpendingByProject = lazy(() =>
  import("./charts/spending-by-project").then((m) => ({
    default: m.SpendingByProject,
  })),
);
const SpendingHeatmap = lazy(() =>
  import("./charts/spending-heatmap").then((m) => ({
    default: m.SpendingHeatmap,
  })),
);
const TaskHeatmap = lazy(() =>
  import("./charts/task-heatmap").then((m) => ({ default: m.TaskHeatmap })),
);
const TaskStatusBoard = lazy(() =>
  import("./charts/task-status-board").then((m) => ({
    default: m.TaskStatusBoard,
  })),
);

type DashboardView = "overview" | "charts" | "data" | "gallery";

const DASHBOARD_VIEW_OPTIONS: ViewSwitcherOption<DashboardView>[] = [
  { value: "overview", label: "Overview" },
  { value: "charts", label: "Charts" },
  { value: "data", label: "Data" },
  { value: "gallery", label: "Gallery" },
];

export function ProjectsDashboard() {
  const api = useTRPC();
  const { data, isLoading } = useQuery({
    ...api.notion.dashboard.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  // Load images lazily — doesn't block dashboard render
  const { data: imageMap } = useQuery({
    ...api.notion.projectImages.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const [filters, setFilters] = useState<Filters>(emptyFilters);

  // Merge lazily-loaded images into project data
  const dataWithImages = useMemo(() => {
    if (!data) return null;
    if (!imageMap) return data;
    return {
      ...data,
      projects: data.projects.map((p) => ({
        ...p,
        coverImage: p.coverImage ?? imageMap[p.id] ?? null,
      })),
    };
  }, [data, imageMap]);

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (!dataWithImages) {
    return (
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
    );
  }

  return (
    <DashboardContent
      data={dataWithImages}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}

function DashboardContent({
  data,
  filters,
  onFiltersChange,
}: {
  data: {
    projects: NotionProject[];
    tasks: NotionTask[];
    purchases: NotionPurchase[];
  };
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
}) {
  const [view, setView] = useState<DashboardView>("overview");
  const availableStatuses = useMemo(
    () => uniq(data.projects.map((p) => p.status).filter(Boolean) as string[]),
    [data.projects],
  );
  const availableKinds = useMemo(
    () => uniq(data.projects.map((p) => p.kind).filter(Boolean) as string[]),
    [data.projects],
  );
  const availableLocations = useMemo(
    () => uniq(data.projects.flatMap((p) => p.location)),
    [data.projects],
  );

  const { projects, tasks, purchases } = useMemo(() => {
    let projects = data.projects;

    if (filters.statuses.size > 0) {
      projects = projects.filter(
        (p) => p.status && filters.statuses.has(p.status),
      );
    }
    if (filters.kinds.size > 0) {
      projects = projects.filter((p) => p.kind && filters.kinds.has(p.kind));
    }
    if (filters.locations.size > 0) {
      projects = projects.filter((p) =>
        p.location.some((l) => filters.locations.has(l)),
      );
    }

    const projectNames = new Set(projects.map((p) => p.name));
    const tasks = data.tasks.filter(
      (t) => !t.projectName || projectNames.has(t.projectName),
    );
    const purchases = data.purchases.filter(
      (p) => !p.projectName || projectNames.has(p.projectName),
    );

    return { projects, tasks, purchases };
  }, [data, filters]);

  return (
    <Stack>
      <SummaryCards projects={projects} tasks={tasks} purchases={purchases} />

      <DashboardFilters
        filters={filters}
        onFiltersChange={onFiltersChange}
        availableStatuses={availableStatuses}
        availableKinds={availableKinds}
        availableLocations={availableLocations}
      />

      <NeedsAttention projects={projects} tasks={tasks} purchases={purchases} />

      <Stack>
        <ViewSwitcher
          ariaLabel="Dashboard view"
          options={DASHBOARD_VIEW_OPTIONS}
          value={view}
          onValueChange={setView}
        />

        {view === "overview" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <Stack className="pt-4">
              <Grid cols="pair">
                <Section
                  title="Cost vs Estimate"
                  description="Projects with both spending and an estimate"
                >
                  <CostVsEstimate projects={projects} purchases={purchases} />
                </Section>
                <Section
                  title="Budget Health"
                  description="Top 12 projects by % of estimate spent"
                >
                  <BudgetHealth projects={projects} purchases={purchases} />
                </Section>
              </Grid>

              <Section title="Top 10 Projects by Spending">
                <SpendingByProject purchases={purchases} projects={projects} />
              </Section>

              <Section
                title="Task Status Board"
                description="Top 15 projects, sorted by date"
              >
                <TaskStatusBoard tasks={tasks} projects={projects} />
              </Section>
            </Stack>
          </Suspense>
        )}

        {view === "charts" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <Stack className="pt-4">
              <Section title="Project Timeline">
                <ProjectTimeline projects={projects} />
              </Section>

              <Section
                title="Project Dependencies"
                description="Arrows show blocking relationships between projects"
              >
                <DependencyGraph projects={projects} />
              </Section>

              <Section title="Monthly Spending Trend">
                <MonthlyTrend purchases={purchases} />
              </Section>

              <Grid cols="pair">
                <Section title="Category Split">
                  <PurchaseDonut
                    purchases={purchases}
                    height={300}
                    centerLabel="All projects"
                  />
                </Section>
                <Section title="Spending Heatmap">
                  <SpendingHeatmap purchases={purchases} />
                </Section>
              </Grid>

              <Section
                title="Task Heatmap"
                description="Task due dates across all projects"
              >
                <TaskHeatmap tasks={tasks} />
              </Section>
            </Stack>
          </Suspense>
        )}

        {view === "data" && (
          <Stack className="pt-4">
            <Stack as="section">
              <h2 className="font-heading font-semibold text-xl">Projects</h2>
              <ProjectTable projects={projects} purchases={purchases} />
            </Stack>

            <Stack as="section">
              <h2 className="font-heading font-semibold text-xl">Tasks</h2>
              <TaskList tasks={tasks} />
            </Stack>

            <Stack as="section">
              <h2 className="font-heading font-semibold text-xl">Purchases</h2>
              <PurchaseList purchases={purchases} />
            </Stack>
          </Stack>
        )}

        {view === "gallery" && (
          <div className="pt-4">
            <ProjectCards projects={projects} />
          </div>
        )}
      </Stack>
    </Stack>
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
  const totalSpend = sumBy(purchases, (p) => p.cost ?? 0);

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card size="sm">
        <CardHeader>
          <CardDescription>Active Projects</CardDescription>
          <CardTitle className="text-2xl">{activeProjects}</CardTitle>
        </CardHeader>
        <CardContent>
          <Row wrap gap="sm">
            {statusCounts(projects.map((p) => p.status)).map(
              ([status, count]) => (
                <Badge key={status} variant="outline">
                  {status}: {count}
                </Badge>
              ),
            )}
          </Row>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Active Tasks</CardDescription>
          <CardTitle className="text-2xl">{activeTasks}</CardTitle>
        </CardHeader>
        <CardContent>
          <Row wrap gap="sm">
            {statusCounts(tasks.map((t) => t.status)).map(([status, count]) => (
              <Badge key={status} variant="outline">
                {status}: {count}
              </Badge>
            ))}
          </Row>
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
          <Description size="xs">{purchases.length} purchases</Description>
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
  const [active, done] = partition(projects, (p) => p.status !== "Done");

  if (active.length === 0 && done.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyIcon icon={Hammer} />
          <EmptyTitle>No projects found</EmptyTitle>
          <EmptyDescription>
            Adjust your filters or check your Notion workspace for projects.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Stack>
      {active.length > 0 && (
        <Grid cols="cards3">
          {active.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </Grid>
      )}
      {done.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground text-sm hover:text-foreground">
            Completed ({done.length})
          </summary>
          <Grid cols="cards3" className="mt-4">
            {done.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </Grid>
        </details>
      )}
    </Stack>
  );
}

function ProjectCard({ project }: { project: NotionProject }) {
  return (
    <Link to="/projects/$id" params={{ id: project.id }} className="block">
      <Card
        size="sm"
        className="overflow-hidden transition-colors hover:bg-muted/50"
      >
        {project.coverImage && (
          <div className="relative aspect-[16/9] w-full overflow-hidden">
            <Image
              src={project.coverImage}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        )}
        <CardHeader>
          <CardTitle>
            {project.icon && <span>{project.icon}</span>}
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
          <Row wrap gap="sm">
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
          </Row>
        </CardContent>
      </Card>
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <Stack>
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cards have no stable identity
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </Stack>
  );
}

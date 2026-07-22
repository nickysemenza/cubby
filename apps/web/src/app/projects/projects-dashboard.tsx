import type { ProjectDashboardOut, ProjectOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { countBy, partition, uniq } from "es-toolkit";
import { Calendar, DollarSign, Hammer, Wallet } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
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
  EmptyActions,
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
import { type RouterOutputs, useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";

import {
  DashboardFilters,
  dateRangeBounds,
  emptyFilters,
  type Filters,
} from "./dashboard-filters";
import { NeedsAttention } from "./needs-attention";
import { ProjectActions } from "./project-actions";
import {
  capitalize,
  formatDateRange,
  PROJECT_STATUS_LABELS,
  ProjectTable,
  PurchaseList,
  StatusIcon,
  TASK_STATUS_LABELS,
  TaskList,
} from "./shared";
import { splitPurchaseSpend } from "./spend";

// Charts are Nivo/d3-heavy and each tab's panel is unmounted until selected, so
// lazy-load them to keep their code out of the dashboard chunk until a tab opens.
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
const PortfolioGantt = lazy(() =>
  import("./charts/gantt/PortfolioGantt").then((m) => ({
    default: m.PortfolioGantt,
  })),
);
const TradeActivity = lazy(() =>
  import("./charts/trade-activity").then((m) => ({
    default: m.TradeActivity,
  })),
);
const CategoryBreakdown = lazy(() =>
  import("./charts/category-breakdown").then((m) => ({
    default: m.CategoryBreakdown,
  })),
);
const PlannedVsActual = lazy(() =>
  import("./charts/planned-vs-actual").then((m) => ({
    default: m.PlannedVsActual,
  })),
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
const TradeProjectMatrix = lazy(() =>
  import("./charts/trade-project-matrix").then((m) => ({
    default: m.TradeProjectMatrix,
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

/** Cover image (first attached image) per project id — keyed lookup for the gallery tab. */
type CoverImages = RouterOutputs["image"]["imagesByProjectIds"];

const NO_PROJECT_IDS: string[] = [];

const route = getRouteApi("/_authenticated/projects/");

export function ProjectsDashboard() {
  const api = useTRPC();
  const { data, isLoading, isError, error, refetch } = useQuery({
    ...api.project.dashboard.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const projectIds = useMemo(
    () => data?.projects.map((p) => p.id) ?? NO_PROJECT_IDS,
    [data],
  );

  // Cover images load lazily on their own query — doesn't block dashboard render.
  const { data: coverImages } = useQuery({
    ...api.image.imagesByProjectIds.queryOptions({ projectIds }),
    staleTime: 5 * 60 * 1000,
    enabled: projectIds.length > 0,
  });

  const search = route.useSearch();
  const navigate = route.useNavigate();

  // Keyed on the joined primitive values (not the array references
  // themselves) so a fresh-array-per-parse from validateSearch doesn't
  // rebuild the Sets — and every downstream memo keyed on `filters` — on
  // every render.
  const statusesKey = search.statuses?.join(",");
  const kindsKey = search.kinds?.join(",");
  const locationsKey = search.locations?.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the joined-string primitives above, not the array references, on purpose
  const filters = useMemo<Filters>(
    () => ({
      statuses: new Set(search.statuses ?? emptyFilters.statuses),
      kinds: new Set(search.kinds ?? emptyFilters.kinds),
      locations: new Set(search.locations ?? emptyFilters.locations),
      dateRange: search.date ?? null,
    }),
    [statusesKey, kindsKey, locationsKey, search.date],
  );

  const handleFiltersChange = (next: Filters) => {
    navigate({
      search: (prev) => ({
        ...prev,
        statuses: next.statuses.size > 0 ? [...next.statuses] : undefined,
        kinds: next.kinds.size > 0 ? [...next.kinds] : undefined,
        locations: next.locations.size > 0 ? [...next.locations] : undefined,
        date: next.dateRange ?? undefined,
      }),
      replace: true,
    });
  };

  if (isError) {
    // Distinct from the loading skeleton — a fetch failure must never read as
    // "still loading" forever.
    return (
      <Empty>
        <EmptyHeader>
          <EmptyIcon icon={Hammer} />
          <EmptyTitle>Couldn't load the project dashboard</EmptyTitle>
          <EmptyDescription>
            {error.message || "Something went wrong."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyActions>
          <Button type="button" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </EmptyActions>
      </Empty>
    );
  }

  if (isLoading || !data) {
    return <DashboardSkeleton />;
  }

  return (
    <DashboardContent
      data={data}
      coverImages={coverImages}
      filters={filters}
      onFiltersChange={handleFiltersChange}
      view={search.view ?? "overview"}
      onViewChange={(v) =>
        navigate({ search: (prev) => ({ ...prev, view: v }), replace: true })
      }
    />
  );
}

function DashboardContent({
  data,
  coverImages,
  filters,
  onFiltersChange,
  view,
  onViewChange,
}: {
  data: ProjectDashboardOut;
  coverImages: CoverImages | undefined;
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  view: DashboardView;
  onViewChange: (v: DashboardView) => void;
}) {
  const projectPreview = useEntityPreview("project");
  const availableStatuses = useMemo(
    () => uniq(data.projects.map((p) => p.status)),
    [data.projects],
  );
  const availableKinds = useMemo(
    () => uniq(data.projects.map((p) => p.kind).filter((k) => k != null)),
    [data.projects],
  );
  const availableLocations = useMemo(
    () => uniq(data.projects.flatMap((p) => p.locations)),
    [data.projects],
  );
  const availableYears = useMemo(
    () =>
      uniq(
        [
          ...data.purchases.map((p) => p.date),
          ...data.tasks.map((t) => t.dueDate),
        ]
          .filter((d) => d != null)
          .map((d) => d.slice(0, 4)),
      )
        .sort()
        .reverse(),
    [data.purchases, data.tasks],
  );

  const { projects, tasks, purchases } = useMemo(() => {
    let projects = data.projects;

    if (filters.statuses.size > 0) {
      projects = projects.filter((p) => filters.statuses.has(p.status));
    }
    if (filters.kinds.size > 0) {
      projects = projects.filter((p) => p.kind && filters.kinds.has(p.kind));
    }
    if (filters.locations.size > 0) {
      projects = projects.filter((p) =>
        p.locations.some((l) => filters.locations.has(l)),
      );
    }

    // Keyed by id, not name — project names aren't unique, so a name-keyed
    // join here would cross-contaminate tasks/purchases across same-named
    // projects.
    const projectIds = new Set(projects.map((p) => p.id));
    let tasks = data.tasks.filter(
      (t) => !t.projectId || projectIds.has(t.projectId),
    );
    let purchases = data.purchases.filter(
      (p) => !p.projectId || projectIds.has(p.projectId),
    );

    // Date scope applies to the time-stamped entities only — a project isn't
    // "in" a month, so the project list never shrinks under a date filter.
    // Undated rows (incl. most future purchases) are excluded by design.
    const bounds = filters.dateRange
      ? dateRangeBounds(filters.dateRange)
      : null;
    if (bounds) {
      tasks = tasks.filter(
        (t) => t.dueDate && t.dueDate >= bounds.from && t.dueDate <= bounds.to,
      );
      purchases = purchases.filter(
        (p) => p.date && p.date >= bounds.from && p.date <= bounds.to,
      );
    }

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
        availableYears={availableYears}
      />

      <NeedsAttention projects={projects} tasks={tasks} purchases={purchases} />

      <Stack>
        <Row justify="between" align="center" wrap gap="sm">
          <ViewSwitcher
            ariaLabel="Dashboard view"
            options={DASHBOARD_VIEW_OPTIONS}
            value={view}
            onValueChange={onViewChange}
          />
          <ProjectActions />
        </Row>

        {view === "overview" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <Stack className="pt-4">
              {/* Two distinct lenses on spend: Cost vs Estimate is budget
                  HEALTH (% of estimate, so Wedding's $175K doesn't dwarf every
                  other bar), scoped to projects that have an estimate at all.
                  Top 10 by Spending is raw dollar ranking across every
                  project (estimated or not), clickable through to the
                  project. */}
              <Section
                title="Cost vs Estimate"
                description="% of budget spent — projects with an estimate only"
              >
                <CostVsEstimate projects={projects} />
              </Section>

              <Section
                title="Top 10 Projects by Spending"
                description="Raw dollar totals, regardless of whether a project has an estimate"
              >
                <SpendingByProject projects={projects} />
              </Section>

              <Section
                title="Task Status Board"
                description="Projects with the most open work first"
              >
                <TaskStatusBoard tasks={tasks} projects={projects} />
              </Section>
            </Stack>
          </Suspense>
        )}

        {view === "charts" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <Stack className="pt-4">
              <Section
                title="Project Timeline"
                description="Bars = own dates · whisker = sub-project span"
              >
                <PortfolioGantt projects={projects} />
              </Section>

              <Section
                title="Trade Activity"
                description="When each trade was last active, across all projects"
              >
                <TradeActivity tasks={tasks} />
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

              <CategoryBreakdown
                purchases={purchases}
                centerLabel="All projects"
              />

              <Section
                title="Spend by Trade"
                description="Committed spend, sub-projects folded into their root project"
              >
                <TradeProjectMatrix projects={projects} purchases={purchases} />
              </Section>

              <Section
                title="Planned vs Actual"
                description="Committed spend vs future-flagged purchases"
              >
                <PlannedVsActual purchases={purchases} />
              </Section>

              <Section title="Spending Heatmap">
                <SpendingHeatmap purchases={purchases} />
              </Section>

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
              <ProjectTable
                projects={projects}
                onRowClick={projectPreview.onRowClick}
                onRowHover={projectPreview.onRowHover}
                PreviewSheet={projectPreview.PreviewSheet}
              />
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
            <ProjectCards projects={projects} coverImages={coverImages} />
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
  projects: ProjectDashboardOut["projects"];
  tasks: ProjectDashboardOut["tasks"];
  purchases: ProjectDashboardOut["purchases"];
}) {
  // Headline counts and the status-badge breakdown must describe the SAME
  // population, else "Active Projects: 8" sits above a "Done: 66" badge. Both
  // count the active (non-done) set.
  const activeProjectsList = projects.filter((p) => p.status !== "done");
  const activeTasksList = tasks.filter((t) => t.status !== "done");
  const spend = splitPurchaseSpend(purchases);

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card size="sm">
        <CardHeader>
          <CardDescription>Active Projects</CardDescription>
          <CardTitle className="text-2xl">
            {activeProjectsList.length}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Row wrap gap="sm">
            {Object.entries(countBy(activeProjectsList, (p) => p.status)).map(
              ([status, count]) => (
                <Badge key={status} variant="outline">
                  {PROJECT_STATUS_LABELS[status as ProjectOut["status"]]}:{" "}
                  {count}
                </Badge>
              ),
            )}
          </Row>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Active Tasks</CardDescription>
          <CardTitle className="text-2xl">{activeTasksList.length}</CardTitle>
        </CardHeader>
        <CardContent>
          <Row wrap gap="sm">
            {Object.entries(countBy(activeTasksList, (t) => t.status)).map(
              ([status, count]) => (
                <Badge key={status} variant="outline">
                  {
                    TASK_STATUS_LABELS[
                      status as (typeof tasks)[number]["status"]
                    ]
                  }
                  : {count}
                </Badge>
              ),
            )}
          </Row>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Actual Spend</CardDescription>
          <CardTitle className="text-2xl">
            {formatCurrency(spend.actual, 0)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Description size="xs">
            {purchases.length} purchases
            {spend.committed > 0 &&
              ` · ${formatCurrency(spend.committed, 0)} committed`}
            {spend.contributions > 0 &&
              ` · ${formatCurrency(spend.contributions, 0)} contributions`}
          </Description>
        </CardContent>
      </Card>
    </div>
  );
}

// -- Project Cards --

function ProjectCards({
  projects,
  coverImages,
}: {
  projects: ProjectOut[];
  coverImages: CoverImages | undefined;
}) {
  // Gallery is a top-level project grid — sub-projects show on their
  // parent's own detail page (Sub-projects section), not as independent
  // cards here. (The dashboard's `project.dashboard` fetch itself stays
  // unfiltered — every other tab/chart on this page still sees the full set,
  // e.g. dependency/spending charts that legitimately span the whole tree.)
  const topLevelProjects = projects.filter((p) => !p.parentProjectId);
  const [active, done] = partition(
    topLevelProjects,
    (p) => p.status !== "done",
  );

  if (active.length === 0 && done.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyIcon icon={Hammer} />
          <EmptyTitle>No projects found</EmptyTitle>
          <EmptyDescription>Adjust your filters.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Stack>
      {active.length > 0 && (
        <Grid cols="cards3">
          {active.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              coverUrl={coverImages?.[project.id]?.[0]?.url}
            />
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
              <ProjectCard
                key={project.id}
                project={project}
                coverUrl={coverImages?.[project.id]?.[0]?.url}
              />
            ))}
          </Grid>
        </details>
      )}
    </Stack>
  );
}

function ProjectCard({
  project,
  coverUrl,
}: {
  project: ProjectOut;
  coverUrl: string | undefined;
}) {
  // subtree degenerates to the project's own numbers for a leaf project (see
  // subtree.ts), so this is safe to use uniformly rather than branching on
  // subtree.projectCount. `actualSpent` (money out, excluding planned +
  // contributions) mirrors the detail hero / table "Actual" — using the net
  // `spent` here would fold planned spend and negative contributions into the
  // badge (e.g. a −$75k contribution reading as "-$65,000 spent").
  const spent = project.rollup.subtree.actualSpent;
  // Compare against the subtree estimate to match the subtree spend scope; fall
  // back to the project's own estimate when the subtree has none.
  const estimate = project.rollup.subtree.costEstimate ?? project.costEstimate;
  const hasEstimate = estimate != null;
  const overBudget = estimate != null && spent > estimate;

  return (
    <Link to="/projects/$id" params={{ id: project.id }} className="block">
      <Card
        size="sm"
        className="overflow-hidden transition-colors hover:bg-muted/50"
      >
        {coverUrl && (
          <div className="relative aspect-[16/9] w-full overflow-hidden">
            <Image
              src={coverUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        )}
        <CardHeader>
          <CardTitle>
            {project.icon && <span>{project.icon}</span>}
            <span className="truncate">{project.name}</span>
          </CardTitle>
          <CardDescription className="flex items-center gap-2">
            <StatusIcon status={project.status} />
            {PROJECT_STATUS_LABELS[project.status]}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Row wrap gap="sm">
            {project.kind && (
              <Badge variant="secondary">{capitalize(project.kind)}</Badge>
            )}
            {project.locations.map((loc) => (
              <Badge key={loc} variant="outline">
                {loc}
              </Badge>
            ))}
            {hasEstimate && (
              <Badge variant="outline">
                <DollarSign className="h-3 w-3" />
                {formatCurrency(estimate ?? 0, 0)}
              </Badge>
            )}
            {spent !== 0 && (
              <Badge
                variant={
                  hasEstimate
                    ? overBudget
                      ? "destructive"
                      : "positive"
                    : "outline"
                }
              >
                <Wallet className="h-3 w-3" />
                {formatCurrency(spent, 0)} spent
              </Badge>
            )}
            {(project.startDate || project.endDate) && (
              <Badge variant="outline">
                <Calendar className="h-3 w-3" />
                {formatDateRange(project.startDate, project.endDate)}
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

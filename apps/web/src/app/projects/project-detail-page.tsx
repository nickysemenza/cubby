import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { sumBy } from "es-toolkit";
import { ArrowLeft, Calendar, DollarSign, ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Skeleton } from "~/components/ui/skeleton";
import { StatusText } from "~/components/ui/status-text";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import { CategoryTreemap } from "./charts/category-treemap";
import { CategoryTrend } from "./charts/category-trend";
import { PurchaseDonut } from "./charts/purchase-donut";
import { SpendingOverTime } from "./charts/spending-over-time";
import { SubcategoryBars } from "./charts/subcategory-bars";
import { TaskHeatmap } from "./charts/task-heatmap";
import { NotionPageContent } from "./notion-content";
import { formatDateRange, PurchaseList, StatusIcon, TaskList } from "./shared";

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const api = useTRPC();
  const { data, isLoading } = useQuery({
    ...api.notion.dashboard.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const { project, tasks, purchases } = useMemo(() => {
    if (!data) return { project: null, tasks: [], purchases: [] };

    const project = data.projects.find((p) => p.id === projectId) ?? null;
    const tasks = data.tasks.filter((t) => t.projectName === project?.name);
    const purchases = data.purchases.filter(
      (p) => p.projectName === project?.name,
    );

    return { project, tasks, purchases };
  }, [data, projectId]);

  if (isLoading) {
    return (
      <Page variant="list" title="Project" decoration="none">
        <DetailSkeleton />
      </Page>
    );
  }

  if (!project) {
    return (
      <Page variant="list" title="Project" decoration="none">
        <Stack>
          <Link
            to="/projects"
            className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to projects
          </Link>
          <Description>Project not found.</Description>
        </Stack>
      </Page>
    );
  }

  const totalCost = sumBy(purchases, (p) => p.cost ?? 0);

  return (
    <Page
      variant="list"
      title={
        <>
          {project.icon && `${project.icon} `}
          {project.name}
        </>
      }
      eyebrow={
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Projects
        </Link>
      }
      actions={
        <a
          href={project.notionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      }
    >
      {/* Cover image */}
      {project.coverImage && (
        <div
          // negative-margin cover bleed; -mx-* is coupled to the w-[calc(100%+Nrem)] compensation, not free spacing
          className="relative -mx-4 mb-0 h-48 w-[calc(100%+2rem)] overflow-hidden rounded-lg sm:-mx-6 sm:w-[calc(100%+3rem)] lg:-mx-8 lg:w-[calc(100%+4rem)]"
        >
          <Image
            src={project.coverImage}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      )}

      {/* Status / kind / location / date badges */}
      <Row align="center" wrap gap="sm">
        <Badge variant="outline" className="gap-1">
          <StatusIcon status={project.status} />
          {project.status ?? "No status"}
        </Badge>
        {project.kind && <Badge variant="secondary">{project.kind}</Badge>}
        {project.location.map((loc) => (
          <Badge key={loc} variant="outline">
            {loc}
          </Badge>
        ))}
        {(project.date || project.dateEnd) && (
          <Badge variant="outline" className="gap-1">
            <Calendar className="h-3 w-3" />
            {formatDateRange(project.date, project.dateEnd)}
          </Badge>
        )}
      </Row>

      {/* Cost summary */}
      <CostSummary
        totalCost={totalCost}
        costEstimate={project.costEstimate}
        purchaseCount={purchases.length}
      />

      {/* Spending over time */}
      {purchases.length > 0 && (
        <Section title="Spending Over Time">
          <SpendingOverTime
            purchases={purchases}
            costEstimate={project.costEstimate}
          />
        </Section>
      )}

      {/* Category breakdown charts */}
      {purchases.length > 0 && (
        <Grid cols="pair">
          <Section title="Spending by Category">
            <PurchaseDonut purchases={purchases} />
          </Section>
          <Section title="Spending by Subcategory">
            <SubcategoryBars purchases={purchases} />
          </Section>
        </Grid>
      )}

      {/* Category treemap + trend */}
      {purchases.length > 0 && (
        <Grid cols="pair">
          <Section title="Category Treemap">
            <CategoryTreemap purchases={purchases} />
          </Section>
          <Section title="Category Trend">
            <CategoryTrend purchases={purchases} />
          </Section>
        </Grid>
      )}

      {/* Task calendar */}
      {tasks.length > 0 && (
        <Section title="Task Timeline">
          <TaskHeatmap tasks={tasks} />
        </Section>
      )}

      {/* Tasks */}
      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">
          Tasks ({tasks.length})
        </h2>
        <TaskList tasks={tasks} />
      </Stack>

      {/* Purchases */}
      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">
          Purchases ({purchases.length})
        </h2>
        <PurchaseList purchases={purchases} />
      </Stack>

      {/* Notion page content */}
      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">Notes</h2>
        <NotionPageContent pageId={project.id} />
      </Stack>
    </Page>
  );
}

function CostSummary({
  totalCost,
  costEstimate,
  purchaseCount,
}: {
  totalCost: number;
  costEstimate: number | null;
  purchaseCount: number;
}) {
  const hasEstimate = costEstimate != null && costEstimate > 0;
  const overBudget = hasEstimate && totalCost > costEstimate;
  const percentage = hasEstimate ? (totalCost / costEstimate) * 100 : null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardDescription>Actual Cost</CardDescription>
          <CardTitle className="text-2xl">
            <Row as="span" align="center" gap="xs">
              <DollarSign className="h-5 w-5" />
              {formatCurrency(totalCost, 0)}
            </Row>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Description size="xs">{purchaseCount} purchases</Description>
        </CardContent>
      </Card>

      {hasEstimate && (
        <Card size="sm">
          <CardHeader>
            <CardDescription>vs Estimate</CardDescription>
            <CardTitle className="text-2xl">
              {formatCurrency(costEstimate, 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {/* Progress bar */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${overBudget ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${Math.min(percentage ?? 0, 100)}%` }}
              />
            </div>
            <StatusText
              as="p"
              tone={overBudget ? "destructive" : "muted"}
              className="text-xs"
            >
              {percentage?.toFixed(0)}% of estimate
              {overBudget &&
                ` (+${formatCurrency(totalCost - costEstimate, 0)} over)`}
            </StatusText>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <Stack gap="lg">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-10 w-64" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
      <Skeleton className="h-[350px] rounded-lg" />
    </Stack>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Calendar, DollarSign, ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { PurchaseDonut } from "./charts/purchase-donut";
import { SubcategoryBars } from "./charts/subcategory-bars";
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
    return <DetailSkeleton />;
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to projects
        </Link>
        <p className="text-muted-foreground">Project not found.</p>
      </div>
    );
  }

  const totalCost = purchases.reduce((sum, p) => sum + (p.cost ?? 0), 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-3">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to projects
        </Link>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="font-bold font-heading text-3xl">{project.name}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1">
                <StatusIcon status={project.status} />
                {project.status ?? "No status"}
              </Badge>
              {project.kind && (
                <Badge variant="secondary">{project.kind}</Badge>
              )}
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
            </div>
          </div>
          <a
            href={project.notionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-5 w-5" />
          </a>
        </div>
      </div>

      {/* Cost summary */}
      <CostSummary
        totalCost={totalCost}
        costEstimate={project.costEstimate}
        purchaseCount={purchases.length}
      />

      {/* Charts */}
      {purchases.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3">
            <h2 className="font-heading font-semibold text-lg">
              Spending by Category
            </h2>
            <PurchaseDonut purchases={purchases} />
          </section>
          <section className="space-y-3">
            <h2 className="font-heading font-semibold text-lg">
              Spending by Subcategory
            </h2>
            <SubcategoryBars purchases={purchases} />
          </section>
        </div>
      )}

      {/* Tasks */}
      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">
          Tasks ({tasks.length})
        </h2>
        <TaskList tasks={tasks} />
      </section>

      {/* Purchases */}
      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">
          Purchases ({purchases.length})
        </h2>
        <PurchaseList purchases={purchases} />
      </section>
    </div>
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
            <span className="flex items-center gap-1">
              <DollarSign className="h-5 w-5" />
              {formatCurrency(totalCost, 0)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-xs">
            {purchaseCount} purchases
          </p>
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
            <p
              className={`text-xs ${overBudget ? "text-destructive" : "text-muted-foreground"}`}
            >
              {percentage?.toFixed(0)}% of estimate
              {overBudget &&
                ` (+${formatCurrency(totalCost - costEstimate, 0)} over)`}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      <div className="h-10 w-64 animate-pulse rounded bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="h-[350px] animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

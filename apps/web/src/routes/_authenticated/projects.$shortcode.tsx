import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { expenseChartDataQueryOptions } from "~/app/expenses/expense.functions";
import { projectOptionsQueryOptions } from "~/app/projects/project.functions";
import { ProjectDetailPage } from "~/app/projects/project-detail-page";
// Loader-only imports MUST come from this dependency-free module, never from
// `project-detail-page` — the loader stays in the eager route chunk, so pulling
// a value out of the page module pins its whole graph (charts, tables) to the
// critical path of every page load.
import {
  projectGanttSubtreeQueryParams,
  projectSubtreeExpensesFilters,
  projectSubtreeTasksFilters,
} from "~/app/projects/project-query-params";
import { taskChartDataQueryOptions } from "~/app/tasks/task.functions";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { entityDetailQueryOptions } from "~/entities/entity-detail.functions";
import { entityListQueryOptions } from "~/entities/entity-list.functions";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/projects/$shortcode")({
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      entityDetailQueryOptions("project", params.shortcode),
    );
    if (!data) throw notFound();

    // Non-blocking warm of the sections rendered below the spec plate — the
    // notFound decision above doesn't depend on them, so they don't gate it.
    // Same params as the component's own queries (both sides call the helpers
    // in project-query-params.ts) so they land in the same cache entry instead
    // of double-fetching.
    //
    // These key on the project's UUID, not its shortcode: the subtree filters
    // are internal query inputs, and the public id has already done its job by
    // getting us the row.
    void context.queryClient.prefetchQuery(
      taskChartDataQueryOptions(projectSubtreeTasksFilters(data.id)),
    );
    void context.queryClient.prefetchQuery(
      expenseChartDataQueryOptions(projectSubtreeExpensesFilters(data.id)),
    );
    void context.queryClient.prefetchQuery(
      entityListQueryOptions(
        "project",
        projectGanttSubtreeQueryParams(data.id),
      ),
    );
    void context.queryClient.prefetchQuery(projectOptionsQueryOptions());
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Project not found" entity="project" compact>
      <Empty>
        <EmptyTitle>Project not found</EmptyTitle>
        <EmptyDescription>
          This project is no longer available.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  head: shortcodeHead,
  component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
  const { shortcode } = Route.useParams();
  const { data: project } = useSuspenseQuery(
    entityDetailQueryOptions("project", shortcode),
  );

  useDetailTitle(shortcode, project?.name);

  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!project) return null;

  return <ProjectDetailPage project={project} />;
}

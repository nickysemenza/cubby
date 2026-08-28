import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { expense } from "~/app/expenses/expense.functions";
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
import { project } from "~/app/projects/project.functions";
import { task } from "~/app/tasks/task.functions";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { entityListFor } from "~/entities/entity-list.functions";
import { shortcodeHead } from "~/lib/page-title";

const ProjectNotFound = notFoundPage(
  "project",
  "Project not found",
  "This project is no longer available.",
);

const ProjectDetailRoute = detailPage({
  query: (shortcode) => entityDetailFor("project").queryOptions(shortcode),
  render: (project) => <ProjectDetailPage project={project} />,
  title: (project) => project.name,
});

export const Route = createFileRoute("/_authenticated/projects/$shortcode")({
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      entityDetailFor("project").queryOptions(params.shortcode),
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
      task.chartData.queryOptions(projectSubtreeTasksFilters(data.id)),
    );
    void context.queryClient.prefetchQuery(
      expense.chartData.queryOptions(projectSubtreeExpensesFilters(data.id)),
    );
    void context.queryClient.prefetchQuery(
      entityListFor("project").queryOptions(
        projectGanttSubtreeQueryParams(data.id),
      ),
    );
    void context.queryClient.prefetchQuery(project.options.queryOptions());
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: ProjectNotFound,
  head: shortcodeHead,
  component: ProjectDetailRoute,
});

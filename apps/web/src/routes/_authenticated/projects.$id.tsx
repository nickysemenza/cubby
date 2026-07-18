import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  ProjectDetailPage,
  projectPurchasesQueryParams,
  projectTasksQueryParams,
} from "~/app/projects/project-detail-page";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/projects/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.project.getByID.queryOptions({ id: params.id }),
    );
    if (!data) throw notFound();

    // Non-blocking warm of the sections rendered below the spec plate — the
    // notFound decision above only needs `getByID`, so these don't gate it.
    // Same params as the component's own queries (see project-detail-page.tsx)
    // so they land in the same cache entry instead of double-fetching.
    void context.queryClient.prefetchQuery(
      context.trpc.task.list.queryOptions(projectTasksQueryParams(params.id)),
    );
    void context.queryClient.prefetchQuery(
      context.trpc.purchase.list.queryOptions(
        projectPurchasesQueryParams(params.id),
      ),
    );
    void context.queryClient.prefetchQuery(
      context.trpc.project.options.queryOptions(),
    );
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
  component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: project } = useSuspenseQuery(
    api.project.getByID.queryOptions({ id }),
  );

  useDocumentTitle(project.name);

  return <ProjectDetailPage project={project} />;
}

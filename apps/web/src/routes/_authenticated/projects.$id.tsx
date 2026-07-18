import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProjectDetailPage } from "~/app/projects/project-detail-page";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/projects/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    // Reuses the list page's `dashboard` query (same cache key) rather than a
    // dedicated getByID — a project has no fields the dashboard shape lacks
    // (see ProjectOut), so navigating in from /projects costs no extra fetch.
    const data = await context.queryClient.ensureQueryData(
      context.trpc.project.dashboard.queryOptions(),
    );
    if (!data.projects.some((p) => p.id === params.id)) throw notFound();
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
  const { data } = useSuspenseQuery(api.project.dashboard.queryOptions());
  const project = data.projects.find((p) => p.id === id);

  useDocumentTitle(project?.name ?? "Project");

  // Unreachable: the loader already threw notFound() when this id is missing.
  if (!project) return null;

  return (
    <ProjectDetailPage
      project={project}
      allProjects={data.projects}
      tasks={data.tasks}
      purchases={data.purchases}
    />
  );
}

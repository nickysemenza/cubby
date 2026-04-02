import { createFileRoute } from "@tanstack/react-router";
import { ProjectDetailPage } from "~/app/projects/project-detail-page";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/projects/$id")({
  component: ProjectDetailRoute,
  head: () => ({ meta: [{ title: "Project | cubby" }] }),
});

function ProjectDetailRoute() {
  const { id } = Route.useParams();

  return (
    <PageWrapper>
      <div className="fade-in animate-in duration-300">
        <ProjectDetailPage projectId={id} />
      </div>
    </PageWrapper>
  );
}

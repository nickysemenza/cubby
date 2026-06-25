import { createFileRoute } from "@tanstack/react-router";
import { ProjectDetailPage } from "~/app/projects/project-detail-page";

export const Route = createFileRoute("/_authenticated/projects/$id")({
  component: ProjectDetailRoute,
  head: () => ({ meta: [{ title: "Project | cubby" }] }),
});

function ProjectDetailRoute() {
  const { id } = Route.useParams();

  return <ProjectDetailPage projectId={id} />;
}

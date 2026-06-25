import { createFileRoute } from "@tanstack/react-router";
import { ProjectsDashboard } from "~/app/projects/projects-dashboard";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/projects/")({
  component: ProjectsPage,
  head: () => ({ meta: [{ title: "Projects | cubby" }] }),
});

function ProjectsPage() {
  return (
    <Page variant="list" title="Projects" fullWidth>
      <ProjectsDashboard />
    </Page>
  );
}

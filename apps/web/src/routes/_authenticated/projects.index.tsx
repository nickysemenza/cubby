import { projectShortcode } from "@cubby/schemas/identifiers";
import {
  createFileRoute,
  Link,
  stripSearchParams,
} from "@tanstack/react-router";
import { Share2 } from "lucide-react";

import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import {
  DASHBOARD_VIEW_OPTIONS,
  ProjectsDashboard,
} from "~/app/projects/projects-dashboard";
import { Button } from "~/components/ui/button";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { projectCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  projectSearchDefaults,
  projectSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

function useProjectsView() {
  const search = Route.useSearch();
  return (
    DASHBOARD_VIEW_OPTIONS.find((option) => option.value === search.view)
      ?.value ?? "overview"
  );
}

function ProjectsWorkbenchControls() {
  const view = useProjectsView();
  const navigate = Route.useNavigate();

  return (
    <ViewSwitcher
      ariaLabel="Dashboard view"
      options={DASHBOARD_VIEW_OPTIONS}
      value={view}
      onValueChange={(nextView) =>
        void navigate({
          search: (previous) => ({ ...previous, view: nextView }),
          replace: true,
        })
      }
    />
  );
}

function ProjectsActions() {
  const search = Route.useSearch();
  const graphProject = projectShortcode.safeParse(search.parent);

  return (
    <>
      <Link
        to="/entities"
        search={{
          tab: "work",
          projectId: graphProject.success ? graphProject.data : undefined,
        }}
      >
        <Button variant="outline">
          <Share2 />
          Graph
        </Button>
      </Link>
      <CreateDialogAction request={projectCaptureRequest()}>
        New Project
      </CreateDialogAction>
    </>
  );
}

// Bound to a const, not inlined into the options object: see the splitter
// note atop `entity-routes.tsx`.
const ProjectsPage = listPage({
  title: "Projects",
  list: ProjectsDashboard,
  bodyGutter: () => "standard",
  workbenchControls: () => <ProjectsWorkbenchControls />,
  actions: () => <ProjectsActions />,
});

export const Route = createFileRoute("/_authenticated/projects/")({
  validateSearch: projectSearchSchema,
  search: { middlewares: [stripSearchParams(projectSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "project",
      search: deps,
      active:
        deps.view === "gallery" ||
        (deps.view === "data" && deps.rows === "flat"),
      defaultSort:
        deps.view === "data" && deps.rows === "flat"
          ? { orderBy: "startDate", direction: "desc" }
          : undefined,
      signal: abortController.signal,
    }),
  component: ProjectsPage,
  head: () => ({ meta: [{ title: pageTitle("Projects") }] }),
});

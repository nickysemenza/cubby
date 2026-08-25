import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import {
  DASHBOARD_VIEW_OPTIONS,
  type DashboardView,
  ProjectsDashboard,
} from "~/app/projects/projects-dashboard";
import { Page } from "~/components/page/Page";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { projectCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  projectSearchDefaults,
  projectSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

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

function ProjectsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const view = (search.view ?? "overview") as DashboardView;

  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Projects"
      layout="full"
      bodyGutter="standard"
      workbenchControls={
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
      }
      actions={
        <CreateDialogAction request={projectCaptureRequest()}>
          New Project
        </CreateDialogAction>
      }
    >
      <ProjectsDashboard />
    </Page>
  );
}

import { projectShortcode } from "@cubby/schemas/identifiers";
import { projectKindSchema, projectStatusSchema } from "@cubby/schemas/project";
import {
  createFileRoute,
  Link,
  stripSearchParams,
} from "@tanstack/react-router";
import { Share2 } from "lucide-react";
import { z } from "zod";

import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { listPage } from "~/app/_components/routing/entity-routes";
import { PROJECT_ROWS_RENDERERS } from "~/app/projects/project-options";
import {
  DASHBOARD_VIEW_OPTIONS,
  type DashboardView,
  ProjectsDashboard,
} from "~/app/projects/projects-dashboard";
import { Button } from "~/components/ui/button";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { projectCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { pageTitle } from "~/lib/page-title";

const PROJECT_RENDERERS = [
  "overview",
  "analytics",
  "data",
  "gallery",
] as const satisfies readonly DashboardView[];

const commaSeparatedArray = <T extends z.ZodType>(itemSchema: T) =>
  z.preprocess((value) => {
    const text = z.string().safeParse(value);
    return text.success
      ? text.data.split(",").filter((item) => item.length > 0)
      : value;
  }, z.array(itemSchema).optional());

const projectSearchSchema = z.object({
  ...entitySearch.project.schema.shape,
  // The dashboard reads these as arrays. Absent `statuses` is unrestricted;
  // an invalid enum value fails this route's validation instead of being
  // forwarded as a widened server query.
  statuses: commaSeparatedArray(projectStatusSchema),
  kinds: commaSeparatedArray(projectKindSchema),
  locations: commaSeparatedArray(z.string()),
  // Unknown renderers are dropped so a stale URL lands on the default.
  view: z.enum(PROJECT_RENDERERS).optional().catch(undefined),
  rows: z.enum(PROJECT_ROWS_RENDERERS).optional().catch(undefined),
});
// `view`/`rows` have a canonical non-`undefined` default (the renderer a bare
// route falls back to), so the URL drops them at that value.
const projectSearchDefaults = {
  ...entitySearch.project.defaults,
  view: "overview",
  rows: "flat",
} as const;

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

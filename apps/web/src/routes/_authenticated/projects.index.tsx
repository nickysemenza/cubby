import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { CreateProjectDialog } from "~/app/projects/create-project-dialog";
import { ProjectsDashboard } from "~/app/projects/projects-dashboard";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-manifest";

const searchSchema = z.object({
  statuses: z.array(z.string()).optional().catch(undefined),
  kinds: z.array(z.string()).optional().catch(undefined),
  locations: z.array(z.string()).optional().catch(undefined),
  date: z.string().optional().catch(undefined),
  view: z
    .enum(["overview", "analytics", "data", "gallery", "history"])
    .optional()
    .catch(undefined),
  // Quick-capture deep link (navbar "+" / command palette) — there is no
  // /projects/new route, so the create dialog is opened by this param.
  create: z.boolean().optional().catch(undefined),
  // ProjectTable's sort/page URL sync writes to this route already — a
  // strict validateSearch without these would strip them.
  ...tableSearchFields,
  ...entityFilterSearchFields("project"),
});

const searchDefaults = {
  statuses: undefined,
  kinds: undefined,
  locations: undefined,
  date: undefined,
  view: "overview",
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/projects/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: ProjectsPage,
  head: () => ({ meta: [{ title: "Projects | cubby" }] }),
});

function ProjectsPage() {
  const { create } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page variant="list" title="Projects" fullWidth>
      <ProjectsDashboard />

      {/* Deep-linked quick capture: open state is read straight off the URL and
          cleared (replace) on close, so a refresh or back-nav can't reopen it. */}
      <CreateProjectDialog
        open={create === true}
        onOpenChange={(open) => {
          if (!open)
            navigate({
              search: (prev) => ({ ...prev, create: undefined }),
              replace: true,
            });
        }}
      />
    </Page>
  );
}

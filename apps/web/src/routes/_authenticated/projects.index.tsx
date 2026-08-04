import { projectKindSchema, projectStatusSchema } from "@cubby/schemas/project";
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
import { entityFilterSearchFields, listHead } from "~/entities/filter-manifest";
import {
  isValidProjectDateFilter,
  normalizeProjectRenderer,
  PROJECT_ROWS_RENDERERS,
} from "~/lib/list-view-normalization";
import { urlStringParam } from "~/lib/search-params";

const dateFilterParam = urlStringParam.refine(
  isValidProjectDateFilter,
  "Invalid project date filter",
);
const completionYearParam = urlStringParam.refine(
  (value) => value === undefined || /^\d{4}$/.test(value),
  "Invalid completion year",
);
/**
 * Which renderer the Data tab's Projects section uses. Piped through the enum
 * rather than left a loose string so the value arrives typed AND an unknown
 * renderer fails validation instead of silently falling back to flat — the URL
 * would otherwise claim a view the page isn't showing.
 */
const rowsRendererParam = urlStringParam.pipe(
  z.enum(PROJECT_ROWS_RENDERERS).optional(),
);
const commaSeparatedArray = <T extends z.ZodType>(itemSchema: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.split(",").filter((item) => item.length > 0)
        : value,
    z.array(itemSchema).optional(),
  );

export const projectSearchSchema = z
  .object({
    ...tableSearchFields,
    ...entityFilterSearchFields("project"),
    // Absent `statuses` is unrestricted. Invalid enum values fail this route's
    // validation instead of being forwarded as a widened server query.
    statuses: commaSeparatedArray(projectStatusSchema),
    kinds: commaSeparatedArray(projectKindSchema),
    locations: commaSeparatedArray(z.string()),
    date: dateFilterParam,
    view: urlStringParam,
    rows: rowsRendererParam,
    // Quick-capture deep link (navbar "+" / command palette) — there is no
    // /projects/new route, so the create dialog is opened by this param.
    create: z.boolean().optional().catch(undefined),
    // ProjectTable's sort/page URL sync writes to this route already — a
    // strict validateSearch without these would strip them.
    completed: completionYearParam,
  })
  .transform(({ view, ...rest }) => {
    const normalized = normalizeProjectRenderer(view);
    return {
      ...rest,
      ...normalized,
      statuses: normalized.statuses ?? rest.statuses,
    };
  });

const searchDefaults = {
  statuses: undefined,
  kinds: undefined,
  locations: undefined,
  date: undefined,
  completed: undefined,
  view: "overview",
  rows: "flat",
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/projects/")({
  validateSearch: projectSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: ProjectsPage,
  head: listHead("Projects", "project"),
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

import { projectKindSchema, projectStatusSchema } from "@cubby/schemas/project";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { ProjectsDashboard } from "~/app/projects/projects-dashboard";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import {
  isValidProjectDateFilter,
  normalizeProjectRenderer,
  PROJECT_ROWS_RENDERERS,
} from "~/lib/list-view-normalization";
import { pageTitle } from "~/lib/page-title";
import { urlShortcodeListParam, urlStringParam } from "~/lib/search-params";

const dateFilterParam = urlStringParam
  .refine(isValidProjectDateFilter, "Invalid project date filter")
  .catch(undefined);
const completionYearParam = urlStringParam
  .refine(
    (value) => value === undefined || /^\d{4}$/.test(value),
    "Invalid completion year",
  )
  .catch(undefined);
/**
 * Which renderer the Data tab's Projects section uses. Piped through the enum
 * rather than left a loose string so the value arrives typed. Unknown renderers
 * are dropped so stale URLs fall back to the canonical default.
 */
const rowsRendererParam = urlStringParam
  .pipe(z.enum(PROJECT_ROWS_RENDERERS).optional())
  .catch(undefined);
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
    parent: urlShortcodeListParam("project"),
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
  head: () => ({ meta: [{ title: pageTitle("Projects") }] }),
});

function ProjectsPage() {
  return (
    <Page variant="list" title="Projects" fullWidth>
      <ProjectsDashboard />
    </Page>
  );
}

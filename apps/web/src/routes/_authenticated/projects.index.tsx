import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { ProjectsDashboard } from "~/app/projects/projects-dashboard";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  statuses: z.array(z.string()).optional().catch(undefined),
  kinds: z.array(z.string()).optional().catch(undefined),
  locations: z.array(z.string()).optional().catch(undefined),
  date: z.string().optional().catch(undefined),
  view: z
    .enum(["overview", "charts", "data", "gallery"])
    .optional()
    .catch(undefined),
  // ProjectTable's sort/page URL sync writes to this route already — a
  // strict validateSearch without these would strip them.
  ...tableSearchFields,
});

const searchDefaults = {
  statuses: undefined,
  kinds: undefined,
  locations: undefined,
  date: undefined,
  view: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/projects/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
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

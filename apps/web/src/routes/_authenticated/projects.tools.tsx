import { projectKindSchema, projectStatusSchema } from "@cubby/schemas/project";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";

import { listChromePage } from "~/app/_components/routing/entity-routes";
import { ToolMatrixPage } from "~/app/projects/tool-matrix-page";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

const commaSeparatedArray = <T extends z.ZodType>(itemSchema: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.split(",").filter((item) => item.length > 0)
        : value,
    z.array(itemSchema).optional(),
  );

const completionYearParam = urlStringParam
  .refine(
    (value) => value === undefined || /^\d{4}$/.test(value),
    "Invalid completion year",
  )
  .catch(undefined);

/**
 * Everything here except a future `focus`/`collapsed` is a server input and
 * therefore part of the query key. Keep it that way: pure presentation
 * state in this object would refetch the whole grid on a column pin.
 *
 * `kinds` is absent by default (all five). A default subset would be an
 * invisible filter — the exact defect the dashboard scope already had to fix.
 */
const toolMatrixSearchSchema = z
  .object({
    kinds: commaSeparatedArray(projectKindSchema),
    statuses: commaSeparatedArray(projectStatusSchema),
    completed: completionYearParam,
    project: urlStringParam,
    page: z.coerce.number().int().positive().optional().catch(undefined),
    tool: urlStringParam,
    floor: z.coerce.number().nonnegative().optional().catch(undefined),
    group: z.enum(["trade", "manufacturer"]).optional().catch(undefined),
  })
  .default({});

export type ToolMatrixSearch = z.infer<typeof toolMatrixSearchSchema>;

// Bound to a const, not inlined into the options object below: see
// `entity-routes.tsx`'s doc comment on why the splitter needs a literal
// identifier here, not an inline factory call.
const ProjectToolMatrixRoute = listChromePage({
  title: "Tool usage matrix",
  eyebrow: "Projects",
  layout: "full",
  page: ToolMatrixBody,
});

export const Route = createFileRoute("/_authenticated/projects/tools")({
  component: ProjectToolMatrixRoute,
  validateSearch: toolMatrixSearchSchema,
  search: {
    middlewares: [stripSearchParams({ floor: 100, group: "trade", page: 1 })],
  },
  head: () => ({ meta: [{ title: pageTitle("Tool usage matrix") }] }),
});

function ToolMatrixBody() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <ToolMatrixPage
      search={search}
      onSearchChange={(next) =>
        navigate({
          search: (prev) => ({ ...prev, ...next }),
          replace: true,
        })
      }
    />
  );
}

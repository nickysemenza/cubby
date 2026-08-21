import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { TasksBoardView } from "~/app/tasks/board/TasksBoardView";
import { NextTasks } from "~/app/tasks/next-tasks";
import { TasksStatsStrip } from "~/app/tasks/TasksStatsStrip";
import { TaskList } from "~/app/tasks/tasklist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { taskCaptureRequest } from "~/entities/editing";
import { getEntityFilters } from "~/entities/filter-manifest";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
} from "~/entities/filters";
import {
  isValidTaskStatusFilter,
  normalizeTaskRenderer,
  type TaskRenderer,
} from "~/lib/list-view-normalization";
import { pageTitle } from "~/lib/page-title";
import {
  urlEnumListParam,
  urlShortcodeListParam,
  urlStringParam,
} from "~/lib/search-params";

// Timeline is the Gantt + the Nivo calendar heatmap, and its tab is unmounted
// until selected — lazy so that stack stays out of the default List view.
const TasksTimelineView = lazy(() =>
  import("~/app/tasks/TasksTimelineView").then((m) => ({
    default: m.TasksTimelineView,
  })),
);

type ViewOption = TaskRenderer;

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "next", label: "Next" },
  { value: "board", label: "Board" },
  { value: "timeline", label: "Timeline" },
  { value: "list", label: "List" },
];

const taskStatusParam = urlStringParam
  .refine(isValidTaskStatusFilter, "Invalid task status filter")
  .catch(undefined);

export const taskSearchSchema = z
  .object({
    ...tableSearchFields,
    ...entityFilterSearchFields("task"),
    q: urlStringParam,
    status: taskStatusParam,
    trade: urlEnumListParam(tradeSchema),
    project: urlShortcodeListParam("project"),
    parentTask: urlShortcodeListParam("task"),
    // Declared by name as well as through the manifest so typed links can set an
    // exact product scope and the visible "For" presence filter.
    productId: urlShortcodeListParam("product"),
    subjectProduct: urlShortcodeListParam("product"),
    view: urlStringParam,
    // Board layout: column axis + swimlane axis. `lane` is normalized to only
    // apply when `cols === "status"` inside TasksBoardView.
    cols: z.enum(["status", "project", "trade"]).optional().catch(undefined),
    lane: z.enum(["project", "trade"]).optional().catch(undefined),
    // Quick-capture deep link (navbar "+" / command palette) — there is no
    // /tasks/new route, so the create dialog is opened by this param.
    create: z.boolean().optional().catch(undefined),
  })
  .transform(({ view, ...rest }) => {
    const normalized = normalizeTaskRenderer(view);
    if (normalized.clearFilters) {
      return {
        ...rest,
        view: normalized.view,
        q: undefined,
        status: undefined,
        project: undefined,
        parentTask: undefined,
        dueDate: undefined,
        trade: undefined,
        subjectProduct: undefined,
        productId: undefined,
      };
    }
    return {
      ...rest,
      ...normalized,
    };
  });

const searchDefaults = {
  q: undefined,
  productId: undefined,
  subjectProduct: undefined,
  view: undefined,
  cols: undefined,
  lane: undefined,
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/tasks/")({
  validateSearch: taskSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: TasksPage,
  head: () => ({ meta: [{ title: pageTitle("Tasks") }] }),
});

function TasksPage() {
  const search = Route.useSearch();
  const { q } = search;
  // Next is an explicitly labeled actionable-work renderer. A search deep
  // link lands on List so its ordinary filter is never ignored.
  const view = search.view ?? (q ? "list" : "next");
  const navigate = useNavigate({ from: Route.fullPath });
  const rendererFilters = buildFiltersFromManifest(
    getEntityFilters("task"),
    filterGetterFromSearch(getEntityFilters("task"), search),
  );

  return (
    // The board's natural width is its fixed column tracks, not the full
    // viewport — only the list views need the full, unconstrained container.
    <Page
      variant="list"
      title="Tasks"
      layout={view !== "board" ? "full" : "contained"}
      // Header-level "New task" so it's reachable from every view (Next/Board
      // have no list toolbar of their own to hang it off).
      actions={<CreateDialogAction request={taskCaptureRequest()} />}
    >
      <Stack gap="md">
        <TasksStatsStrip />

        <ViewSwitcher
          ariaLabel="Tasks view"
          options={VIEW_SWITCHER_OPTIONS}
          value={view}
          onValueChange={(v) =>
            // Merge, don't replace — a plain object here would drop `q` (and
            // any table-search params) from the URL on every view switch.
            navigate({ search: (prev) => ({ ...prev, view: v }) })
          }
        />

        {view === "next" && <NextTasks filters={rendererFilters} />}

        {view === "board" && <TasksBoardView filters={rendererFilters} />}

        {view === "timeline" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <TasksTimelineView filters={rendererFilters} />
          </Suspense>
        )}

        {view === "list" && <TaskList initialSearch={q} />}
      </Stack>
    </Page>
  );
}

import { tradeSchema } from "@cubby/schemas/project";

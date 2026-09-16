import { projectShortcode } from "@cubby/schemas/identifiers";
import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Share2 } from "lucide-react";
import { lazy, Suspense } from "react";
import { z } from "zod";

import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { TasksBoardView } from "~/app/tasks/board/TasksBoardView";
import { NextTasks } from "~/app/tasks/next-tasks";
import { TaskList } from "~/app/tasks/tasklist";
import { TasksStatsStrip } from "~/app/tasks/TasksStatsStrip";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { taskCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
} from "~/entities/filters";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

const TASK_RENDERERS = ["next", "board", "timeline", "list"] as const;
type TaskRenderer = (typeof TASK_RENDERERS)[number];

// Route-only keys on top of the generated task search: the free-text search,
// the renderer, and the board's column/swimlane axes. `lane` only applies
// when `cols === "status"` (normalized inside TasksBoardView).
const taskSearchSchema = z.object({
  ...entitySearch.task.schema.shape,
  q: urlStringParam,
  view: z.enum(TASK_RENDERERS).optional().catch(undefined),
  cols: z.enum(["status", "project", "trade"]).optional().catch(undefined),
  lane: z.enum(["project", "trade"]).optional().catch(undefined),
});
const taskSearchDefaults = {
  ...entitySearch.task.defaults,
  q: undefined,
  view: undefined,
  cols: undefined,
  lane: undefined,
};

// Timeline is the Gantt + the Nivo calendar heatmap, and its tab is unmounted
// until selected — lazy so that stack stays out of the default List view.
const TasksTimelineView = lazy(() =>
  import("~/app/tasks/TasksTimelineView").then((m) => ({
    default: m.TasksTimelineView,
  })),
);

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<TaskRenderer>[] = [
  { value: "next", label: "Next" },
  { value: "board", label: "Board" },
  { value: "timeline", label: "Timeline" },
  { value: "list", label: "List" },
];

export const Route = createFileRoute("/_authenticated/tasks/")({
  validateSearch: taskSearchSchema,
  search: { middlewares: [stripSearchParams(taskSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "task",
      search: deps,
      active: deps.view === "list" || (!deps.view && Boolean(deps.q)),
      signal: abortController.signal,
    }),
  component: TasksPage,
  head: () => ({ meta: [{ title: pageTitle("Tasks") }] }),
});

function TasksPage() {
  const search = Route.useSearch();
  const graphProject = projectShortcode.safeParse(search.project);
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
      listChrome="workbench"
      title="Tasks"
      layout={view !== "board" ? "full" : "contained"}
      bodyGutter={view === "list" || view === "board" ? "none" : "standard"}
      // Header-level "New task" so it's reachable from every view (Next/Board
      // have no list toolbar of their own to hang it off).
      actions={
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
          <CreateDialogAction request={taskCaptureRequest()} />
        </>
      }
      workbenchControls={
        <ViewSwitcher
          ariaLabel="Tasks view"
          options={VIEW_SWITCHER_OPTIONS}
          value={view}
          onValueChange={(v) =>
            // Merge, don't replace: q and the remaining table-search params
            // survive switching among Next, Board, Timeline, and List.
            navigate({ search: (prev) => ({ ...prev, view: v }) })
          }
        />
      }
    >
      <Stack gap="md">
        <TasksStatsStrip />

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

import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { TasksBoardView } from "~/app/tasks/board/TasksBoardView";
import { CreateTaskDialog } from "~/app/tasks/create-task-dialog";
import { TaskInbox } from "~/app/tasks/inbox";
import { NextTasks } from "~/app/tasks/next-tasks";
import { TasksStatsStrip } from "~/app/tasks/TasksStatsStrip";
import { TaskActions } from "~/app/tasks/task-actions";
import { TaskList } from "~/app/tasks/tasklist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Skeleton } from "~/components/ui/skeleton";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { entityFilterSearchFields } from "~/entities/filter-manifest";
import { urlStringParam } from "~/lib/search-params";

// Timeline is the Gantt + the Nivo calendar heatmap, and its tab is unmounted
// until selected — lazy so that stack stays out of the default List view.
const TasksTimelineView = lazy(() =>
  import("~/app/tasks/TasksTimelineView").then((m) => ({
    default: m.TasksTimelineView,
  })),
);

const viewOptions = [
  "next",
  "inbox",
  "board",
  "timeline",
  "all",
  "history",
] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "next", label: "Next" },
  { value: "inbox", label: "Inbox" },
  { value: "board", label: "Board" },
  { value: "timeline", label: "Timeline" },
  { value: "all", label: "All" },
  { value: "history", label: "History" },
];

const searchSchema = z.object({
  q: urlStringParam,
  view: z.enum(viewOptions).optional().catch(undefined),
  // Board layout: column axis + swimlane axis. `lane` is normalized to only
  // apply when `cols === "status"` inside TasksBoardView.
  cols: z.enum(["status", "project", "trade"]).optional().catch(undefined),
  lane: z.enum(["project", "trade"]).optional().catch(undefined),
  // Quick-capture deep link (navbar "+" / command palette) — there is no
  // /tasks/new route, so the create dialog is opened by this param.
  create: z.boolean().optional().catch(undefined),
  ...tableSearchFields,
  ...entityFilterSearchFields("task"),
});

const searchDefaults = {
  q: undefined,
  view: undefined,
  cols: undefined,
  lane: undefined,
  create: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/tasks/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: TasksPage,
  head: () => ({ meta: [{ title: "Tasks | cubby" }] }),
});

function TasksPage() {
  const search = Route.useSearch();
  const { q } = search;
  // Default to the "what can I do next" view rather than the full list, which
  // is dominated by completed tasks. A search deep-link (`q`) still lands on
  // the All list so its seeded search isn't silently ignored.
  const view = search.view ?? (q ? "all" : "next");
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    // The board's natural width is its fixed column tracks, not the full
    // viewport — only the list views need the wide, unconstrained container.
    <Page
      variant="list"
      title="Tasks"
      fullWidth={view !== "board"}
      // Header-level "New task" so it's reachable from every view (Next/Board
      // have no list toolbar of their own to hang it off).
      actions={<TaskActions />}
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

        {view === "next" && <NextTasks />}

        {view === "inbox" && <TaskInbox />}

        {view === "board" && <TasksBoardView />}

        {view === "timeline" && (
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <TasksTimelineView />
          </Suspense>
        )}

        {view === "all" && <TaskList initialSearch={q} />}

        {view === "history" && <TaskList completion="done" />}
      </Stack>

      {/* Deep-linked quick capture: open state is read straight off the URL and
          cleared (replace) on close, so a refresh or back-nav can't reopen it. */}
      <CreateTaskDialog
        open={search.create === true}
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

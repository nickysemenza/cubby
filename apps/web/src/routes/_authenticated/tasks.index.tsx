import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { ActionableTasks } from "~/app/tasks/actionable-tasks";
import { TasksBoardView } from "~/app/tasks/board/TasksBoardView";
import { TasksStatsStrip } from "~/app/tasks/TasksStatsStrip";
import { TasksTimelineView } from "~/app/tasks/TasksTimelineView";
import { TaskActions } from "~/app/tasks/task-actions";
import { TaskList } from "~/app/tasks/tasklist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";

const viewOptions = ["all", "actionable", "board", "timeline"] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "all", label: "All" },
  { value: "actionable", label: "Actionable" },
  { value: "board", label: "Board" },
  { value: "timeline", label: "Timeline" },
];

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: z.enum(viewOptions).optional().catch(undefined),
  // Board layout: column axis + swimlane axis. `lane` is normalized to only
  // apply when `cols === "status"` inside TasksBoardView.
  cols: z.enum(["status", "project", "trade"]).optional().catch(undefined),
  lane: z.enum(["project", "trade"]).optional().catch(undefined),
  ...tableSearchFields,
});

const searchDefaults = {
  q: undefined,
  view: undefined,
  cols: undefined,
  lane: undefined,
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
  // Default to the actionable "what can I do next" view rather than the full
  // list, which is dominated by completed tasks. A search deep-link (`q`) still
  // lands on the All list so its seeded search isn't silently ignored.
  const view = search.view ?? (q ? "all" : "actionable");
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    // The board's natural width is its fixed column tracks, not the full
    // viewport — only the list view needs the wide, unconstrained container.
    <Page
      variant="list"
      title="Tasks"
      fullWidth={view !== "board"}
      // Header-level "New task" so it's reachable from every view (the default
      // Actionable view has no list toolbar to hang it off).
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

        {view === "all" && <TaskList initialSearch={q} />}

        {view === "actionable" && <ActionableTasks />}

        {view === "board" && <TasksBoardView />}

        {view === "timeline" && <TasksTimelineView />}
      </Stack>
    </Page>
  );
}

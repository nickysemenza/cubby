import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { ActionableTasks } from "~/app/tasks/actionable-tasks";
import { TasksBoardView } from "~/app/tasks/board/TasksBoardView";
import { TaskActions } from "~/app/tasks/task-actions";
import { TaskList } from "~/app/tasks/tasklist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";

const viewOptions = ["all", "actionable", "board"] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "all", label: "All" },
  { value: "actionable", label: "Actionable" },
  { value: "board", label: "Board" },
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
  const { q, view = "all" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    // The board's natural width is its fixed column tracks, not the full
    // viewport — only the list view needs the wide, unconstrained container.
    <Page variant="list" title="Tasks" fullWidth={view !== "board"}>
      <Stack gap="md">
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

        {view === "all" && (
          <TaskList initialSearch={q} actions={<TaskActions />} />
        )}

        {view === "actionable" && <ActionableTasks />}

        {view === "board" && <TasksBoardView />}
      </Stack>
    </Page>
  );
}

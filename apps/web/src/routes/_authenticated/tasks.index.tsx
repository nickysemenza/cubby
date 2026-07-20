import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { ActionableTasks } from "~/app/tasks/actionable-tasks";
import { TaskActions } from "~/app/tasks/task-actions";
import { TaskList } from "~/app/tasks/tasklist";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";

const viewOptions = ["all", "actionable"] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "all", label: "All" },
  { value: "actionable", label: "Actionable" },
];

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  view: z.enum(viewOptions).optional().catch(undefined),
  ...tableSearchFields,
});

const searchDefaults = { q: undefined, view: undefined } as const;

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
    <Page variant="list" title="Tasks" fullWidth>
      <Stack gap="md">
        <ViewSwitcher
          ariaLabel="Tasks view"
          options={VIEW_SWITCHER_OPTIONS}
          value={view}
          onValueChange={(v) => navigate({ search: { view: v } })}
        />

        {view === "all" && (
          <TaskList initialSearch={q} actions={<TaskActions />} />
        )}

        {view === "actionable" && <ActionableTasks />}
      </Stack>
    </Page>
  );
}

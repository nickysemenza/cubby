import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { TaskActions } from "~/app/tasks/task-actions";
import { TaskList } from "~/app/tasks/tasklist";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  ...tableSearchFields,
});

const searchDefaults = { q: undefined } as const;

export const Route = createFileRoute("/_authenticated/tasks/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: TasksPage,
  head: () => ({ meta: [{ title: "Tasks | cubby" }] }),
});

function TasksPage() {
  const { q } = Route.useSearch();

  return (
    <Page variant="list" title="Tasks" fullWidth>
      <TaskList initialSearch={q} actions={<TaskActions />} />
    </Page>
  );
}

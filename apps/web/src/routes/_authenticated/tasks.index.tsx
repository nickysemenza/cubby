import { createFileRoute } from "@tanstack/react-router";
import { TaskActions } from "~/app/tasks/task-actions";
import { TaskList } from "~/app/tasks/tasklist";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/tasks/")({
  component: TasksPage,
  head: () => ({ meta: [{ title: "Tasks | cubby" }] }),
});

function TasksPage() {
  return (
    <Page variant="list" title="Tasks" fullWidth>
      <TaskList actions={<TaskActions />} />
    </Page>
  );
}

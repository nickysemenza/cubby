import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { TaskDetail } from "~/app/tasks/task-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/tasks/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.task.getByID.queryOptions({ id: params.id }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Task not found" entity="task" compact>
      <Empty>
        <EmptyTitle>Task not found</EmptyTitle>
        <EmptyDescription>This task is no longer available.</EmptyDescription>
      </Empty>
    </Page>
  ),
  component: TaskDetailPage,
});

function TaskDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: task } = useSuspenseQuery(
    api.task.getByID.queryOptions({ id }),
  );

  useDocumentTitle(task.name);

  return <TaskDetail key={id} task={task} />;
}

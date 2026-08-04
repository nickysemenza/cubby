import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { TaskDetail } from "~/app/tasks/task-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/tasks/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.task.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
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
  head: shortcodeHead,
  component: TaskDetailPage,
});

function TaskDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: task } = useSuspenseQuery(
    api.task.getByShortcode.queryOptions({ shortcode }),
  );

  useDetailTitle(shortcode, task?.name);

  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!task) return null;

  return <TaskDetail key={shortcode} task={task} />;
}

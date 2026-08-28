import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { TaskDetail } from "~/app/tasks/task-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const TaskDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("task").queryOptions(shortcode),
  render: (task, shortcode) => <TaskDetail key={shortcode} task={task} />,
  title: (task) => task.name,
});

const TaskNotFound = notFoundPage(
  "task",
  "Task not found",
  "This task is no longer available.",
);

export const Route = createFileRoute("/_authenticated/tasks/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("task").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: TaskNotFound,
  head: shortcodeHead,
  component: TaskDetailPage,
});

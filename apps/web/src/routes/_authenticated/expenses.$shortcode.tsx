import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExpenseDetail } from "~/app/expenses/expense-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/expenses/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.expense.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Expense not found" entity="expense" compact>
      <Empty>
        <EmptyTitle>Expense not found</EmptyTitle>
        <EmptyDescription>
          This expense is no longer available.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  component: ExpenseDetailPage,
});

function ExpenseDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: expense } = useSuspenseQuery(
    api.expense.getByShortcode.queryOptions({ shortcode }),
  );

  useDocumentTitle(expense?.name);

  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!expense) return null;

  return <ExpenseDetail key={shortcode} expense={expense} />;
}

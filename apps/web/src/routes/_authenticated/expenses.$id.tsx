import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExpenseDetail } from "~/app/expenses/expense-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/expenses/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.expense.getByID.queryOptions({ id: params.id }),
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
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: expense } = useSuspenseQuery(
    api.expense.getByID.queryOptions({ id }),
  );

  useDocumentTitle(expense.name);

  return <ExpenseDetail key={id} expense={expense} />;
}

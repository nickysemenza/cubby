import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { FinancialTransactionDetail } from "~/app/finance/financial-transaction-detail";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";
export const Route = createFileRoute(
  "/_authenticated/financial-transactions/$shortcode",
)({
  ssr: false,
  loader: async ({ params, context }) => {
    const item = await context.queryClient.ensureQueryData(
      context.trpc.financialTransaction.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!item) throw notFound();
  },
  head: shortcodeHead,
  component: TransactionPage,
});
function TransactionPage() {
  const api = useTRPC();
  const { shortcode } = Route.useParams();
  const { data } = useSuspenseQuery(
    api.financialTransaction.getByShortcode.queryOptions({ shortcode }),
  );
  // Same fallback chain the detail page's own header uses.
  useDetailTitle(shortcode, data?.merchant || data?.rawDescription);
  return data ? <FinancialTransactionDetail transaction={data} /> : null;
}

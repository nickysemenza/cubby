import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { FinancialAccountDetail } from "~/app/finance/financial-account-detail";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";
export const Route = createFileRoute(
  "/_authenticated/financial-accounts/$shortcode",
)({
  loader: async ({ params, context }) => {
    const item = await context.queryClient.ensureQueryData(
      context.trpc.financialAccount.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!item) throw notFound();
  },
  head: shortcodeHead,
  component: AccountPage,
});
function AccountPage() {
  const api = useTRPC();
  const { shortcode } = Route.useParams();
  const { data } = useSuspenseQuery(
    api.financialAccount.getByShortcode.queryOptions({ shortcode }),
  );
  useDetailTitle(shortcode, data?.name);
  return data ? <FinancialAccountDetail account={data} /> : null;
}

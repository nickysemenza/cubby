import { createFileRoute } from "@tanstack/react-router";
import { FinancialAccountActions } from "~/app/finance/account-actions";
import { FinancialAccountList } from "~/app/finance/financial-account-list";
import { Page } from "~/components/page/Page";
export const Route = createFileRoute("/_authenticated/financial-accounts/")({
  component: () => (
    <Page
      variant="list"
      title="Accounts"
      entity="financialAccount"
      fullWidth
      actions={<FinancialAccountActions />}
    >
      <FinancialAccountList />
    </Page>
  ),
  head: () => ({ meta: [{ title: "Accounts | cubby" }] }),
});

import { createFileRoute } from "@tanstack/react-router";
import { FinancialTransactionList } from "~/app/finance/financial-transaction-list";
import { FinancialTransactionActions } from "~/app/finance/transaction-actions";
import { Page } from "~/components/page/Page";
export const Route = createFileRoute("/_authenticated/financial-transactions/")(
  {
    component: () => (
      <Page
        variant="list"
        title="Transactions"
        entity="financialTransaction"
        fullWidth
        actions={<FinancialTransactionActions />}
      >
        <FinancialTransactionList />
      </Page>
    ),
    head: () => ({ meta: [{ title: "Transactions | cubby" }] }),
  },
);

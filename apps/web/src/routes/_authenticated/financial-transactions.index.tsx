import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { CreateFinancialTransactionDialog } from "~/app/finance/create-financial-transaction-dialog";
import { FinancialTransactionList } from "~/app/finance/financial-transaction-list";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { urlStringParam } from "~/lib/search-params";

const searchSchema = z.object({
  ...entityFilterSearchFields("financialTransaction"),
  q: urlStringParam,
  ...tableSearchFields,
});

const searchDefaults = { q: undefined } as const;

export const Route = createFileRoute("/_authenticated/financial-transactions/")(
  {
    validateSearch: searchSchema,
    search: { middlewares: [stripSearchParams(searchDefaults)] },
    component: () => (
      <Page
        variant="list"
        title="Transactions"
        entity="financialTransaction"
        fullWidth
        actions={
          <CreateDialogAction Dialog={CreateFinancialTransactionDialog} />
        }
      >
        <FinancialTransactionList />
      </Page>
    ),
    head: () => ({ meta: [{ title: "Transactions | cubby" }] }),
  },
);

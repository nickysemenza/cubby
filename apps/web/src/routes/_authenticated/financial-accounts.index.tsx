import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { CreateFinancialAccountDialog } from "~/app/finance/create-financial-account-dialog";
import { FinancialAccountList } from "~/app/finance/financial-account-list";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-manifest";
import { urlStringParam } from "~/lib/search-params";

const searchSchema = z.object({
  ...entityFilterSearchFields("financialAccount"),
  q: urlStringParam,
  ...tableSearchFields,
});

const searchDefaults = { q: undefined } as const;

export const Route = createFileRoute("/_authenticated/financial-accounts/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: () => (
    <Page
      variant="list"
      title="Accounts"
      entity="financialAccount"
      fullWidth
      actions={<CreateDialogAction Dialog={CreateFinancialAccountDialog} />}
    >
      <FinancialAccountList />
    </Page>
  ),
  head: () => ({ meta: [{ title: "Accounts | cubby" }] }),
});

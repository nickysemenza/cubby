import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import {
  CreateDialogAction,
  createDialogSearchField,
} from "~/app/_components/forms/create-dialog-action";
import { CreateFinancialAccountDialog } from "~/app/finance/create-financial-account-dialog";
import { FinancialAccountList } from "~/app/finance/financial-account-list";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import { urlEnumListParam, urlStringParam } from "~/lib/search-params";

export const financialAccountSearchSchema = z.object({
  ...entityFilterSearchFields("financialAccount"),
  q: urlStringParam,
  identity: urlEnumListParam(financialAccountIdentityKind),
  provisional: urlEnumListParam(z.enum(["true", "false"])),
  ...tableSearchFields,
  ...createDialogSearchField,
});

const searchDefaults = { q: undefined, create: undefined } as const;

export const Route = createFileRoute("/_authenticated/financial-accounts/")({
  validateSearch: financialAccountSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: () => (
    <Page
      variant="list"
      headerInToolbar
      title="Accounts"
      entity="financialAccount"
      fullWidth
      actions={<CreateDialogAction Dialog={CreateFinancialAccountDialog} />}
    >
      <FinancialAccountList />
    </Page>
  ),
  head: () => ({ meta: [{ title: pageTitle("Accounts") }] }),
});

import { financialAccountIdentityKind } from "@cubby/schemas/financial-account";

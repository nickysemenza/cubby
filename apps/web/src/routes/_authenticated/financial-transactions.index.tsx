import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import {
  CreateDialogAction,
  createDialogSearchField,
} from "~/app/_components/forms/create-dialog-action";
import { FinancialTransactionList } from "~/app/finance/financial-transaction-list";
import { Page } from "~/components/page/Page";
import { financialTransactionCaptureRequest } from "~/entities/editing";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import {
  urlEnumListParam,
  urlShortcodeListParam,
  urlStringParam,
} from "~/lib/search-params";

export const financialTransactionSearchSchema = z.object({
  ...entityFilterSearchFields("financialTransaction"),
  q: urlStringParam,
  merchant: urlStringParam,
  kind: urlEnumListParam(financialTransactionKind),
  status: urlEnumListParam(financialTransactionStatus),
  accountId: urlShortcodeListParam("financialAccount"),
  purchaseId: urlShortcodeListParam("purchase"),
  ...tableSearchFields,
  ...createDialogSearchField,
});

const searchDefaults = { q: undefined, create: undefined } as const;

export const Route = createFileRoute("/_authenticated/financial-transactions/")(
  {
    validateSearch: financialTransactionSearchSchema,
    search: { middlewares: [stripSearchParams(searchDefaults)] },
    component: () => (
      <Page
        variant="list"
        headerInToolbar
        title="Transactions"
        entity="financialTransaction"
        layout="full"
        actions={
          <CreateDialogAction request={financialTransactionCaptureRequest()} />
        }
      >
        <FinancialTransactionList />
      </Page>
    ),
    head: () => ({ meta: [{ title: pageTitle("Transactions") }] }),
  },
);

import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";

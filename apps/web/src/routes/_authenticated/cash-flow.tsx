import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import {
  cashFlowSearchDefaults,
  cashFlowSearchSchema,
} from "~/features/finance/cash-flow-search";
import { CashFlowView } from "~/features/finance/cash-flow-view";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/cash-flow")({
  validateSearch: cashFlowSearchSchema,
  search: { middlewares: [stripSearchParams(cashFlowSearchDefaults)] },
  head: () => ({ meta: [{ title: pageTitle("Cash flow") }] }),
  component: CashFlowPage,
});

function CashFlowPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Page variant="list" title="Cash flow" layout="full">
      <CashFlowView
        search={search}
        onSearchChange={(next) =>
          void navigate({
            search: (prev) => ({ ...prev, ...next }),
            replace: true,
          })
        }
      />
    </Page>
  );
}

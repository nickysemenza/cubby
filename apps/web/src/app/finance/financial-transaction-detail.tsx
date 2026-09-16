import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { Info } from "lucide-react";
import { useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { financialTransactionEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { entities, entityDetailParams } from "~/entities/entities";
import { EntityBasicInfo } from "~/entities/entity-display";
import { formatCurrency } from "~/lib/utils";

import { DetailSections } from "../_components/data-table/detail-page";
import { TableLink } from "../_components/table/TableLink";
import { PossibleVendor } from "./possible-vendor";

export function FinancialTransactionDetail({
  record: transaction,
}: {
  record: FinancialTransactionOut;
}) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <Page
      variant="detail"
      entity="financialTransaction"
      title={
        transaction.merchant || transaction.rawDescription || "Transaction"
      }
      rawData={transaction}
      heroActions={{
        primary: <DetailEditAction onClick={() => setEditOpen(true)} />,
      }}
      heroStats={[
        { label: "Amount", value: formatCurrency(transaction.amount) },
        { label: "Status", value: transaction.status },
      ]}
    >
      <DetailSections
        rawData={transaction}
        sections={[
          {
            id: "overview",
            title: "Overview",
            icon: Info,
            placement: "primary",
            content: (
              <EntityBasicInfo
                entity="financialTransaction"
                record={transaction}
                overrides={{
                  merchant: (r) => ({
                    value: r.merchant ? (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ merchant: r.merchant }}
                        label={`Show all transactions matching ${r.merchant}`}
                        variant="value"
                      >
                        {r.merchant}
                      </EntityFilterLink>
                    ) : (
                      "—"
                    ),
                  }),
                  vendorInference: (r) => ({
                    value:
                      r.vendorInference?.status === "suggested" ||
                      r.vendorInference?.status === "ambiguous" ? (
                        <PossibleVendor inference={r.vendorInference} />
                      ) : undefined,
                  }),
                  amount: (r) => ({ value: formatCurrency(r.amount) }),
                  kind: (r) => ({
                    value: r.kind,
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ kind: r.kind }}
                        label={`Show all ${r.kind.replaceAll("_", " ")} transactions`}
                      />
                    ),
                  }),
                  status: (r) => ({
                    value: r.status,
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ status: r.status }}
                        label={`Show all ${r.status} transactions`}
                      />
                    ),
                  }),
                  accountId: (r) => ({
                    value: (
                      <TableLink
                        to={entities.financialAccount.routes.detail}
                        params={entityDetailParams(r.accountId)}
                      >
                        {r.accountName ?? r.accountId}
                      </TableLink>
                    ),
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ accountId: r.accountId }}
                        label={`Show all transactions for ${r.accountName ?? r.accountId}`}
                      />
                    ),
                  }),
                  allocations: (r) => ({
                    // One card line can settle several Purchases, so this shows the
                    // allocation set rather than the single derived mirror — which is NULL
                    // precisely when the answer is interesting.
                    label: r.allocations.length > 1 ? "Settles" : "Purchase",
                    value:
                      r.allocations.length === 0 ? (
                        "—"
                      ) : (
                        <Stack gap="tight">
                          {r.allocations.map((a) => (
                            <Row key={a.purchaseId} justify="between" gap="sm">
                              <Row align="center" gap="tight">
                                <TableLink
                                  to={entities.purchase.routes.detail}
                                  params={entityDetailParams(a.purchaseId)}
                                  variant="mono"
                                >
                                  {a.purchaseId}
                                </TableLink>
                                <EntityFilterLink
                                  to="/financial-transactions"
                                  search={{ purchaseId: a.purchaseId }}
                                  label={`Show all transactions allocated to ${a.purchaseId}`}
                                />
                              </Row>
                              {r.allocations.length > 1 ? (
                                <span className="font-mono tabular-nums">
                                  {formatCurrency(a.amount)}
                                </span>
                              ) : null}
                            </Row>
                          ))}
                        </Stack>
                      ),
                  }),
                  postedDate: (r) => ({ value: r.postedDate ?? "—" }),
                  sourceRefs: (r) => ({
                    value:
                      r.sourceRefs
                        .map((x) => `${x.source}: ${x.externalId}`)
                        .join(", ") || "—",
                  }),
                }}
              />
            ),
          },
        ]}
      />
      <EntityEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        request={financialTransactionEditRequest(transaction)}
      />
    </Page>
  );
}

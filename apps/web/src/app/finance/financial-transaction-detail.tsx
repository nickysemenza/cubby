import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { Info } from "lucide-react";
import { useState } from "react";
import { BasicInfo } from "~/components/common/basic-info";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { financialTransactionEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import { DetailSections } from "../_components/data-table/detail-page";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { TableLink } from "../_components/table/TableLink";
export function FinancialTransactionDetail({
  transaction,
}: {
  transaction: FinancialTransactionOut;
}) {
  const api = useTRPC();
  const [editOpen, setEditOpen] = useState(false);
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: transaction.id,
    name: transaction.merchant || transaction.rawDescription || transaction.id,
    entity: "financialTransaction",
    entityLabel: "Transaction",
    mutationOptions: api.financialTransaction.delete.mutationOptions,
    redirectTo: "/financial-transactions",
  });
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
        secondary: deleteButton,
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
              <BasicInfo
                fields={[
                  {
                    label: "Merchant",
                    value: transaction.merchant ? (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ merchant: transaction.merchant }}
                        label={`Show all transactions matching ${transaction.merchant}`}
                        variant="value"
                      >
                        {transaction.merchant}
                      </EntityFilterLink>
                    ) : (
                      "—"
                    ),
                  },
                  {
                    label: "Amount",
                    value: formatCurrency(transaction.amount),
                  },
                  {
                    label: "Kind",
                    value: transaction.kind,
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ kind: transaction.kind }}
                        label={`Show all ${transaction.kind.replaceAll("_", " ")} transactions`}
                      />
                    ),
                  },
                  {
                    label: "Status",
                    value: transaction.status,
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ status: transaction.status }}
                        label={`Show all ${transaction.status} transactions`}
                      />
                    ),
                  },
                  {
                    label: "Account",
                    value: (
                      <TableLink
                        to={entities.financialAccount.routes.detail}
                        params={entityDetailParams(transaction.accountId)}
                      >
                        {transaction.accountName ?? transaction.accountId}
                      </TableLink>
                    ),
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-transactions"
                        search={{ accountId: transaction.accountId }}
                        label={`Show all transactions for ${transaction.accountName ?? transaction.accountId}`}
                      />
                    ),
                  },
                  {
                    // One card line can settle several Purchases, so this shows
                    // the allocation set rather than the single derived mirror —
                    // which is NULL precisely when the answer is interesting.
                    label:
                      transaction.allocations.length > 1
                        ? "Settles"
                        : "Purchase",
                    value:
                      transaction.allocations.length === 0 ? (
                        "—"
                      ) : (
                        <Stack gap="tight">
                          {transaction.allocations.map((allocation) => (
                            <Row
                              key={allocation.purchaseId}
                              justify="between"
                              gap="sm"
                            >
                              <Row align="center" gap="tight">
                                <TableLink
                                  to={entities.purchase.routes.detail}
                                  params={entityDetailParams(
                                    allocation.purchaseId,
                                  )}
                                  variant="mono"
                                >
                                  {allocation.purchaseId}
                                </TableLink>
                                <EntityFilterLink
                                  to="/financial-transactions"
                                  search={{
                                    purchaseId: allocation.purchaseId,
                                  }}
                                  label={`Show all transactions allocated to ${allocation.purchaseId}`}
                                />
                              </Row>
                              {transaction.allocations.length > 1 ? (
                                <span className="font-mono tabular-nums">
                                  {formatCurrency(allocation.amount)}
                                </span>
                              ) : null}
                            </Row>
                          ))}
                        </Stack>
                      ),
                  },
                  { label: "Posted", value: transaction.postedDate ?? "—" },
                  {
                    label: "References",
                    value:
                      transaction.sourceRefs
                        .map((r) => `${r.source}: ${r.externalId}`)
                        .join(", ") || "—",
                  },
                ]}
              />
            ),
          },
          // History is appended automatically by `DetailSections` for every
          // auditable entity — see `ACTIVITY_SECTION_ID` there.
        ]}
      />
      <EntityEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        request={financialTransactionEditRequest(transaction)}
      />
      {deleteDialog}
    </Page>
  );
}

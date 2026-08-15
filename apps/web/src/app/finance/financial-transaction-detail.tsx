import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { Clock, Info } from "lucide-react";
import { useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { BasicInfo } from "~/components/common/basic-info";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { financialTransactionMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { DetailSections } from "../_components/data-table/detail-page";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { TableLink } from "../_components/table/TableLink";
import { EditFinancialTransactionDialog } from "./edit-financial-transaction-dialog";
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
    invalidateKeys: financialTransactionMutationInvalidateKeys,
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
      actions={
        <>
          <DetailEditAction onClick={() => setEditOpen(true)} />
          {deleteButton}
        </>
      }
      heroStats={[
        { label: "Amount", value: formatCurrency(transaction.amount) },
        { label: "Status", value: transaction.status },
      ]}
    >
      <DetailSections
        rawData={transaction}
        sections={[
          {
            title: "Overview",
            icon: Info,
            content: (
              <BasicInfo
                fields={[
                  { label: "Merchant", value: transaction.merchant ?? "—" },
                  {
                    label: "Amount",
                    value: formatCurrency(transaction.amount),
                  },
                  { label: "Kind", value: transaction.kind },
                  { label: "Status", value: transaction.status },
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
                              <TableLink
                                to={entities.purchase.routes.detail}
                                params={entityDetailParams(
                                  allocation.purchaseId,
                                )}
                                variant="mono"
                              >
                                {allocation.purchaseId}
                              </TableLink>
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
          {
            title: "History",
            icon: Clock,
            content: (
              <AuditLogList
                entityType="financialTransaction"
                entityId={transaction.id}
                showEntityLink={false}
              />
            ),
          },
        ]}
      />
      <EditFinancialTransactionDialog
        transaction={transaction}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      {deleteDialog}
    </Page>
  );
}

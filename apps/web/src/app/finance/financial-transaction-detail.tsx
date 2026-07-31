import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { Clock, Info, Pencil } from "lucide-react";
import { useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { BasicInfo } from "~/components/common/basic-info";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { financialTransactionMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { DetailSections } from "../_components/data-table/detail-page";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
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
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil />
            Edit
          </Button>
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
                  { label: "Account", value: transaction.accountId },
                  { label: "Purchase", value: transaction.purchaseId ?? "—" },
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

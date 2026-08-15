import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import { Clock, Info, ReceiptText } from "lucide-react";
import { useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { BasicInfo } from "~/components/common/basic-info";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { useTRPC } from "~/integrations/trpc/react";
import { financialAccountMutationInvalidateKeys } from "~/lib/query-keys";
import { DetailSections } from "../_components/data-table/detail-page";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { EditFinancialAccountDialog } from "./edit-financial-account-dialog";
import { LinkedTransactions } from "./linked-transactions";
export function FinancialAccountDetail({
  account,
}: {
  account: FinancialAccountOut;
}) {
  const api = useTRPC();
  const [editOpen, setEditOpen] = useState(false);
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: account.id,
    name: account.name,
    entity: "financialAccount",
    entityLabel: "Account",
    mutationOptions: api.financialAccount.delete.mutationOptions,
    invalidateKeys: financialAccountMutationInvalidateKeys,
    redirectTo: "/financial-accounts",
  });
  return (
    <Page
      variant="detail"
      entity="financialAccount"
      title={account.name}
      rawData={account}
      actions={
        <>
          <DetailEditAction onClick={() => setEditOpen(true)} />
          {deleteButton}
        </>
      }
    >
      <DetailSections
        rawData={account}
        sections={[
          {
            title: "Overview",
            icon: Info,
            content: (
              <BasicInfo
                fields={[
                  { label: "Name", value: account.name },
                  {
                    label: "Identity",
                    value: (
                      <span className="font-mono">
                        {account.identity.kind.replaceAll("_", " ")}
                      </span>
                    ),
                  },
                  {
                    label: "Provisional",
                    value: account.provisional ? "Yes" : "No",
                  },
                  {
                    label: "Aliases",
                    value:
                      account.sourceAliases
                        .map((a) => `${a.source}: ${a.alias}`)
                        .join(", ") || "—",
                  },
                  { label: "Notes", value: account.notes ?? "—" },
                ]}
              />
            ),
          },
          {
            title: "Transactions",
            icon: ReceiptText,
            content: <LinkedTransactions accountId={account.id} />,
          },
          {
            title: "History",
            icon: Clock,
            content: (
              <AuditLogList
                entityType="financialAccount"
                entityId={account.id}
                showEntityLink={false}
              />
            ),
          },
        ]}
      />
      <EditFinancialAccountDialog
        account={account}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      {deleteDialog}
    </Page>
  );
}

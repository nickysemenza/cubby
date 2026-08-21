import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import { Clock, Info, ReceiptText } from "lucide-react";
import { useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { BasicInfo } from "~/components/common/basic-info";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import {
  EntityEditDialog,
  financialAccountEditRequest,
} from "~/entities/editing";
import { useTRPC } from "~/integrations/trpc/react";
import { financialAccountMutationInvalidateKeys } from "~/lib/query-keys";
import { renderOptionCell } from "../_components/data-table/columnHelpers";
import { DetailSections } from "../_components/data-table/detail-page";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import {
  accountIdentityKindOptions,
  provisionalOptions,
} from "./financial-account-options";
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
                    value: renderOptionCell(
                      account.identity.kind,
                      accountIdentityKindOptions,
                    ),
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-accounts"
                        search={{ identity: account.identity.kind }}
                        label={`Show all ${account.identity.kind.replaceAll("_", " ")} accounts`}
                      />
                    ),
                  },
                  {
                    label: "Provisional",
                    value: renderOptionCell(
                      account.provisional ? "true" : "false",
                      provisionalOptions,
                    ),
                    filterAction: (
                      <EntityFilterLink
                        to="/financial-accounts"
                        search={{ provisional: String(account.provisional) }}
                        label={
                          account.provisional
                            ? "Show all provisional accounts"
                            : "Show all known accounts"
                        }
                      />
                    ),
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
      <EntityEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        request={financialAccountEditRequest(account)}
      />
      {deleteDialog}
    </Page>
  );
}

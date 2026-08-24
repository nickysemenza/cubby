import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import { Info, ReceiptText } from "lucide-react";
import { useState } from "react";
import { BasicInfo } from "~/components/common/basic-info";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { financialAccountEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { useTRPC } from "~/integrations/trpc/react";
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
    redirectTo: "/financial-accounts",
  });
  return (
    <Page
      variant="detail"
      entity="financialAccount"
      title={account.name}
      rawData={account}
      heroActions={{
        primary: <DetailEditAction onClick={() => setEditOpen(true)} />,
        secondary: deleteButton,
      }}
    >
      <DetailSections
        rawData={account}
        sections={[
          {
            id: "overview",
            title: "Overview",
            icon: Info,
            placement: "primary",
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
            id: "transactions",
            title: "Transactions",
            icon: ReceiptText,
            placement: "primary",
            content: <LinkedTransactions accountId={account.id} />,
          },
          // History is appended automatically by `DetailSections` for every
          // auditable entity — see `ACTIVITY_SECTION_ID` there.
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

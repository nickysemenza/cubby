import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import { Info, ReceiptText } from "lucide-react";
import { useState } from "react";

import { TableLink } from "~/app/_components/table/TableLink";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";
import { financialAccountEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { entities, entityDetailParams } from "~/entities/entities";
import { EntityBasicInfo } from "~/entities/entity-display";

import { renderOptionCell } from "../_components/data-table/columnHelpers";
import { DetailSections } from "../_components/data-table/detail-page";
import {
  accountIdentityKindOptions,
  provisionalOptions,
} from "./financial-account-options";
import { LinkedTransactions } from "./linked-transactions";
export function FinancialAccountDetail({
  record: account,
}: {
  record: FinancialAccountOut;
}) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <Page
      variant="detail"
      entity="financialAccount"
      title={account.name}
      rawData={account}
      heroActions={{
        primary: <DetailEditAction onClick={() => setEditOpen(true)} />,
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
              <EntityBasicInfo
                entity="financialAccount"
                record={account}
                overrides={{
                  ledgerPartyId: () => ({
                    value: account.ledgerPartyId ? (
                      <TableLink
                        to={entities.ledgerParty.routes.detail}
                        params={entityDetailParams(account.ledgerPartyId)}
                      >
                        {account.ledgerPartyName ?? account.ledgerPartyId}
                      </TableLink>
                    ) : (
                      <NoneValue />
                    ),
                    filterAction: account.ledgerPartyId ? (
                      <EntityFilterLink
                        to="/ledger-parties"
                        search={{ q: account.ledgerPartyName ?? undefined }}
                        label="Show this party"
                      />
                    ) : undefined,
                  }),
                  identity: () => ({
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
                  }),
                  provisional: () => ({
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
                  }),
                  sourceAliases: () => ({
                    value:
                      account.sourceAliases
                        .map((a) => `${a.source}: ${a.alias}`)
                        .join(", ") || "—",
                  }),
                }}
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
    </Page>
  );
}

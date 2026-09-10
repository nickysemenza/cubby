import type { FinancialAccountOut } from "@cubby/schemas/financial-account";
import type { LedgerPartyOut } from "@cubby/schemas/ledger-party";
import type { LedgerTransferOut } from "@cubby/schemas/ledger-transfer";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, CreditCard, Info } from "lucide-react";
import { useMemo } from "react";

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { DetailSections } from "~/app/_components/data-table/detail-page";
import type { RelationshipEntity } from "~/app/_components/relationships/relationship-tree";
import { RelationshipTree } from "~/app/_components/relationships/relationship-tree";
import { Page } from "~/components/page/Page";
import { EntityBasicInfo } from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import { formatCurrency } from "~/lib/utils";

import { ledgerPartyKindOptions } from "./ledger-party-columns";

/**
 * A generous, non-paginated page size for a household's own roster of
 * accounts — precedent: `entities.tsx`'s vendor merge-candidate query, which
 * fetches the whole roster the same way rather than adding a second filtered
 * endpoint. `FinancialAccount` has no `ledgerPartyId` filter today (see
 * `packages/schemas/src/financial-account.ts`), so this filters client-side
 * on the already-resolved `ledgerPartyId` field instead of scoping the query
 * server-side.
 */
const ACCOUNT_ROSTER_PAGE_SIZE = 200;

function transferItem(
  transfer: LedgerTransferOut,
  otherPartyId: string,
): RelationshipEntity {
  return {
    entity: "ledgerTransfer",
    id: transfer.id,
    label: `${formatCurrency(transfer.amount)} · ${otherPartyId}`,
    displayImage: null,
    facts: [transfer.date],
  };
}

function accountItem(account: FinancialAccountOut): RelationshipEntity {
  return {
    entity: "financialAccount",
    id: account.id,
    label: account.name,
    displayImage: null,
    facts: [account.identity.kind.replaceAll("_", " ")],
  };
}

/**
 * `LedgerParty` has no curated `related-view.ts` registration (household
 * ledger relationships are rendered in the household contribution ledger
 * instead — see `ENTITIES_WITHOUT_RELATED_VIEWS`), so its relations are
 * fed to `RelationshipTree` by hand rather than through the generic
 * `relatedData` preview endpoints, which only resolve
 * curated relation keys.
 */
export function LedgerPartyDetail({ party }: { party: LedgerPartyOut }) {
  const accountsQuery = useQuery(
    entityListFor("financialAccount").queryOptions({
      filters: {},
      sort: [{ orderBy: "name", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: ACCOUNT_ROSTER_PAGE_SIZE },
    }),
  );
  const outgoingQuery = useQuery(
    entityListFor("ledgerTransfer").queryOptions({
      filters: { fromPartyId: party.id },
      sort: [{ orderBy: "date", direction: "desc" }],
      pagination: { pageIndex: 0, pageSize: ACCOUNT_ROSTER_PAGE_SIZE },
    }),
  );
  const incomingQuery = useQuery(
    entityListFor("ledgerTransfer").queryOptions({
      filters: { toPartyId: party.id },
      sort: [{ orderBy: "date", direction: "desc" }],
      pagination: { pageIndex: 0, pageSize: ACCOUNT_ROSTER_PAGE_SIZE },
    }),
  );

  const accountItems = useMemo<RelationshipEntity[]>(
    () =>
      (accountsQuery.data?.items ?? [])
        .filter((account) => account.ledgerPartyId === party.id)
        .map(accountItem),
    [accountsQuery.data, party.id],
  );
  const outgoingItems = useMemo<RelationshipEntity[]>(
    () =>
      (outgoingQuery.data?.items ?? []).map((transfer) =>
        transferItem(transfer, transfer.toPartyId),
      ),
    [outgoingQuery.data],
  );
  const incomingItems = useMemo<RelationshipEntity[]>(
    () =>
      (incomingQuery.data?.items ?? []).map((transfer) =>
        transferItem(transfer, transfer.fromPartyId),
      ),
    [incomingQuery.data],
  );

  return (
    <Page
      variant="detail"
      entity="ledgerParty"
      title={party.name}
      rawData={party}
    >
      <DetailSections
        rawData={party}
        sections={[
          {
            id: "overview",
            title: "Overview",
            icon: Info,
            placement: "primary",
            content: (
              <EntityBasicInfo
                entity="ledgerParty"
                record={party}
                overrides={{
                  kind: (record) => ({
                    value: renderOptionCell(
                      record.kind,
                      ledgerPartyKindOptions,
                    ),
                  }),
                }}
              />
            ),
          },
          {
            id: "accounts",
            title: "Financial accounts",
            icon: CreditCard,
            placement: "primary",
            content: (
              <RelationshipTree
                presets={[
                  {
                    key: "accounts",
                    label: "Financial accounts",
                    groups: [
                      {
                        key: "financial-accounts",
                        label: "Financial accounts",
                        totalCount: accountItems.length,
                        items: accountItems,
                      },
                    ],
                  },
                ]}
              />
            ),
          },
          {
            id: "transfers",
            title: "Transfers",
            icon: ArrowLeftRight,
            placement: "primary",
            content: (
              <RelationshipTree
                presets={[
                  {
                    key: "transfers",
                    label: "Transfers",
                    groups: [
                      {
                        key: "outgoing-transfers",
                        label: "Outgoing",
                        totalCount: outgoingItems.length,
                        items: outgoingItems,
                      },
                      {
                        key: "incoming-transfers",
                        label: "Incoming",
                        totalCount: incomingItems.length,
                        items: incomingItems,
                      },
                    ],
                  },
                ]}
                initialExpandedGroupKeys={[
                  "transfers:root:outgoing-transfers",
                  "transfers:root:incoming-transfers",
                ]}
              />
            ),
          },
          // History is appended automatically by `DetailSections` for every
          // auditable entity — see `ACTIVITY_SECTION_ID` there.
        ]}
      />
    </Page>
  );
}

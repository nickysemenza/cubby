import type { LedgerPartyOut } from "@cubby/schemas/ledger-party";
import type { LedgerTransferOut } from "@cubby/schemas/ledger-transfer";
import { useQueries } from "@tanstack/react-query";
import { Info, ReceiptText } from "lucide-react";
import { useMemo } from "react";

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { DetailSections } from "~/app/_components/data-table/detail-page";
import type { RelationshipEntity } from "~/app/_components/relationships/relationship-tree";
import { RelationshipTree } from "~/app/_components/relationships/relationship-tree";
import { TableLink } from "~/app/_components/table/TableLink";
import { BasicInfo } from "~/components/common/basic-info";
import { Page } from "~/components/page/Page";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { formatCurrency } from "~/lib/utils";

import { ledgerTransferClassificationOptions } from "./ledger-transfer-columns";

/** A resolved party name, falling back to the bare shortcode while loading. */
function partyLink(id: string, party: LedgerPartyOut | null | undefined) {
  return (
    <TableLink
      to={entities.ledgerParty.routes.detail}
      params={entityDetailParams(id)}
      className="inline"
    >
      {party?.name ?? id}
    </TableLink>
  );
}

/**
 * `LedgerTransfer.evidenceTransactionIds` is already the complete, resolved
 * set (max 2 — see `ledgerTransferEvidenceTransactionIds`), so this fetches
 * each transaction's own detail record rather than scoping a
 * `financialTransaction` list query: that entity has no `ledgerTransferId`
 * filter today (see `packages/schemas/src/financial-transaction.ts`), and one
 * isn't needed when the id set is already in hand.
 */
export function LedgerTransferDetail({
  transfer,
}: {
  transfer: LedgerTransferOut;
}) {
  const partyQueries = useQueries({
    queries: [transfer.fromPartyId, transfer.toPartyId].map((id) =>
      entityDetailFor("ledgerParty").queryOptions(id),
    ),
    combine: (results) => ({
      fromParty: results[0]?.data,
      toParty: results[1]?.data,
    }),
  });
  const evidenceQueries = useQueries({
    queries: transfer.evidenceTransactionIds.map((id) =>
      entityDetailFor("financialTransaction").queryOptions(id),
    ),
    combine: (results) => ({
      transactions: results
        .map((result) => result.data)
        .filter((data) => data != null),
    }),
  });

  const evidenceItems = useMemo<RelationshipEntity[]>(
    () =>
      evidenceQueries.transactions.map((tx) => ({
        entity: "financialTransaction",
        id: tx.id,
        label: tx.merchant || tx.rawDescription || tx.id,
        displayImage: null,
        facts: [
          formatCurrency(tx.amount),
          tx.postedDate ?? tx.transactionDate,
        ].filter((fact): fact is string => fact != null),
      })),
    [evidenceQueries.transactions],
  );

  return (
    <Page
      variant="detail"
      entity="ledgerTransfer"
      title={`${formatCurrency(transfer.amount)} transfer`}
      rawData={transfer}
    >
      <DetailSections
        rawData={transfer}
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
                    label: "From",
                    value: partyLink(
                      transfer.fromPartyId,
                      partyQueries.fromParty,
                    ),
                  },
                  {
                    label: "To",
                    value: partyLink(transfer.toPartyId, partyQueries.toParty),
                  },
                  { label: "Amount", value: formatCurrency(transfer.amount) },
                  { label: "Date", value: transfer.date },
                  {
                    label: "Classification",
                    value: renderOptionCell(
                      transfer.classification,
                      ledgerTransferClassificationOptions,
                    ),
                  },
                  { label: "Notes", value: transfer.notes ?? "—" },
                ]}
              />
            ),
          },
          {
            id: "evidence",
            title: "Evidence transactions",
            icon: ReceiptText,
            placement: "primary",
            content: (
              <RelationshipTree
                presets={[
                  {
                    key: "evidence",
                    label: "Evidence transactions",
                    groups: [
                      {
                        key: "evidence-transactions",
                        label: "Evidence transactions",
                        totalCount: evidenceItems.length,
                        items: evidenceItems,
                      },
                    ],
                  },
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

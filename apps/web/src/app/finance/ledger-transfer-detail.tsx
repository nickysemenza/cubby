import type { LedgerTransferOut } from "@cubby/schemas/ledger-transfer";
import { useQueries } from "@tanstack/react-query";
import { Info, ReceiptText } from "lucide-react";
import { useMemo } from "react";

import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { DetailSections } from "~/app/_components/data-table/detail-page";
import type { RelationshipEntity } from "~/app/_components/relationships/relationship-tree";
import { RelationshipTree } from "~/app/_components/relationships/relationship-tree";
import { TableLink } from "~/app/_components/table/TableLink";
import { Page } from "~/components/page/Page";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { EntityBasicInfo } from "~/entities/entity-display";
import { formatCurrency } from "~/lib/utils";

import { ledgerTransferClassificationOptions } from "./ledger-transfer-columns";

function partyLink(id: string, name: string) {
  return (
    <TableLink
      to={entities.ledgerParty.routes.detail}
      params={entityDetailParams(id)}
      className="inline"
    >
      {name}
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
  record: transfer,
}: {
  record: LedgerTransferOut;
}) {
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
              <EntityBasicInfo
                entity="ledgerTransfer"
                record={transfer}
                overrides={{
                  fromPartyId: (record) => ({
                    value: partyLink(record.fromPartyId, record.fromPartyName),
                  }),
                  toPartyId: (record) => ({
                    value: partyLink(record.toPartyId, record.toPartyName),
                  }),
                  amount: (record) => ({
                    value: formatCurrency(record.amount),
                  }),
                  classification: (record) => ({
                    value: renderOptionCell(
                      record.classification,
                      ledgerTransferClassificationOptions,
                    ),
                  }),
                }}
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

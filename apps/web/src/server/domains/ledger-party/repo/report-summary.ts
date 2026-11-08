import type { ReportBlock } from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { inventoryRepositoryReadSchema } from "~/entity/generated/entity-schema-bindings.inventory.gen";
import type { Database } from "~/server/db";
import { householdContributionLedger } from "~/server/domains/household-contribution/repo/reports";
import { inventoryScaffold } from "~/server/domains/inventory/repo/crud";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

export async function partyContributionSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "ledgerParty", code);
  const ledger = await householdContributionLedger(db, {});
  const partyCode = parseShortcodeFor("ledgerParty", code);
  const party = ledger.parties.find((row) => row.party.id === partyCode);
  if (!party)
    throw new Error("Ledger party is absent from the contribution ledger.");
  return [
    {
      kind: "stats",
      figures: [
        {
          label: "Contribution position",
          value: party.position,
          format: "money",
        },
        {
          label: "Net contribution",
          value: party.netContribution,
          format: "money",
        },
        {
          label: "Attributed consumption",
          value: party.consumed,
          format: "money",
        },
        {
          label: "Initially outlaid",
          value: party.initiallyOutlaid,
          format: "money",
        },
      ],
    },
    {
      kind: "note",
      text: "Advisory contribution context, not a debt or a request to settle.",
    },
    ...(ledger.gaps.length || ledger.gapsTruncated
      ? [
          {
            kind: "note" as const,
            text: "The household ledger has attribution or evidence gaps; these figures are incomplete.",
            tone: "warning" as const,
          },
        ]
      : []),
  ];
}
export async function partyHoldingsSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "ledgerParty", code);
  const owner = parseShortcodeFor("ledgerParty", code);
  const result = await inventoryScaffold.read(db, {
    filters: { ownerLedgerPartyId: [owner] },
    sorts: [],
    pagination: { pageIndex: 0, pageSize: 3 },
    projection: selectedListProjection(inventoryRepositoryReadSchema, [
      "id",
      "displayName",
    ]),
  });
  const rows = z
    .array(z.object({ id: z.string(), displayName: z.string() }))
    .parse(result.data);
  return [
    {
      kind: "records",
      totalCount: result.count,
      rows: rows.map((row) => ({
        entity: "inventory",
        id: row.id,
        title: row.displayName,
        trailing: null,
      })),
      listLink: { entity: "inventory", filters: { owner: code } },
      empty: "No holdings with this effective owner.",
      footer:
        "Includes recorded and inherited ownership; stock remains an estimate.",
    },
  ];
}

import type { ReportBlock } from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { financialTransactionCoverage } from "@cubby/schemas/purchase-evidence-policy";
import { sourceTransactionRecordMatchState } from "@cubby/schemas/source-transaction-record";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { financialTransactionBookingSql } from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { sourceTransactionRecordScaffold } from "~/server/domains/transaction-import/repo/entity-repositories";
import { sourceObservations } from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  CHARGE_STATE,
  chargeKeyOf,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

export async function importReconciliationSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const storedImportId = await resolveOrThrow(db, "transactionImport", code);
  const importId = parseShortcodeFor("transactionImport", code);
  const counts = await Promise.all(
    sourceTransactionRecordMatchState.options.map(async (state) => {
      const result = await sourceTransactionRecordScaffold.read(db, {
        filters: { importId: [importId], matchState: [state] },
        sorts: [],
        pagination: { pageIndex: 0, pageSize: 1 },
        projection: selectedListProjection("sourceTransactionRecord", ["id"]),
        readIntent: "count",
      });
      return { state, count: z.number().parse(result.count) };
    }),
  );
  // Charge state includes observations outside this collection; IN counts each
  // accepted transaction once even when several retained observations support it.
  const bookingResult = await unwrapDb(db).execute(
    sql`
    SELECT coverage.booking, count(*)::int AS count
    FROM (
      SELECT ${financialTransactionBookingSql("ft")} AS booking
      FROM "FinancialTransaction" ft
      WHERE ${notDeleted("ft")} AND ft.shortcode IN (
        SELECT cs.shortcode
        FROM "TransactionImportRecord" member
        JOIN ${sourceObservations} r ON r.id = member."statementRowId" AND ${notDeleted("r")}
        JOIN ${CHARGE_STATE} cs ON cs.source = r.source AND cs."chargeKey" = ${chargeKeyOf("r")}
        WHERE member."importId" = ${storedImportId}::uuid
          AND NOT cs.ignored AND NOT cs.superseded AND cs.shortcode IS NOT NULL
      )
    ) coverage
    GROUP BY coverage.booking
  `,
    "objects",
  );
  const bookingCounts = z
    .array(
      z.object({
        booking: financialTransactionCoverage.shape.booking,
        count: z.coerce.number().int().nonnegative(),
      }),
    )
    .parse(bookingResult);
  const heldHistory = await unwrapDb(db).execute<{
    historical: number;
    neverMatched: number;
  }>(
    sql`
    SELECT count(*) FILTER (WHERE cardinality(r."historicalTransactionIds") > 0)::int AS historical,
      count(*) FILTER (WHERE cardinality(r."historicalTransactionIds") = 0)::int AS "neverMatched"
    FROM "TransactionImportRecord" member JOIN ${sourceObservations} r ON r.id=member."statementRowId"
    WHERE member."importId"=${storedImportId}::uuid AND ${notDeleted("r")} AND r."matchState"=${sourceTransactionRecordMatchState.enum.held}`,
    "objects",
  );
  const bookingLabels = {
    missing: "Unbooked",
    partial: "Partly booked",
    recorded: "Booked",
    not_applicable: "Not required",
    unclassified: "Unclassified",
  } satisfies Record<
    z.infer<typeof financialTransactionCoverage.shape.booking>,
    string
  >;
  return [
    {
      kind: "stats",
      title: "Retained observations",
      figures: [
        ...counts.map(({ state, count }) => ({
          label: state.charAt(0).toUpperCase() + state.slice(1),
          value: count,
          format: "count" as const,
        })),
        {
          label: "Held with historical links",
          value: heldHistory[0]?.historical ?? 0,
          format: "count",
        },
        {
          label: "Held without historical links",
          value: heldHistory[0]?.neverMatched ?? 0,
          format: "count",
        },
      ],
    },
    {
      kind: "note",
      text: "Counts describe retained provider observations, not unique charges or spending. Intake completion and reconciliation are separate.",
    },
    {
      kind: "stats",
      title: "Accepted-owner transaction booking",
      figures: financialTransactionCoverage.shape.booking.options.map(
        (booking) => ({
          label: bookingLabels[booking],
          value:
            bookingCounts.find((row) => row.booking === booking)?.count ?? 0,
          format: "count",
        }),
      ),
    },
    {
      kind: "note",
      text: "Each matched Financial Transaction counts once here. Collections can overlap, so do not add their counts. Booked means the linked Purchases have priced Expense rows; it does not prove balanced settlement, complete sources or itemization. Unmatched observations are excluded.",
    },
  ];
}

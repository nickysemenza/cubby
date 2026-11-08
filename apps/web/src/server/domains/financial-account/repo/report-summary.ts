import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { FinancialTransactionFilters } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { financialTransactionRepositoryReadSchema } from "~/entity/generated/entity-schema-bindings.financialTransaction.gen";
import { formatCurrency } from "~/lib/number-format";
import type { Database } from "~/server/db";
import { financialTransactionScaffold } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

export async function accountReviewSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "financialAccount", code);
  const accountId = parseShortcodeFor("financialAccount", code);
  const gaps: NonNullable<FinancialTransactionFilters["dataGap"]> = [
    "financial_transaction_booking",
    "financial_transaction_allocation",
    "financial_transaction_classification",
  ];
  const result = await financialTransactionScaffold.read(db, {
    filters: { accountId: [accountId], dataGap: gaps },
    sorts: [{ orderBy: "transactionDate", direction: "desc" }],
    pagination: { pageIndex: 0, pageSize: 3 },
    projection: selectedListProjection(
      financialTransactionRepositoryReadSchema,
      ["id", "merchant", "amount", "transactionDate"],
    ),
  });
  const rows = z
    .array(
      z.object({
        id: z.string(),
        merchant: z.string().nullable(),
        amount: z.number(),
        transactionDate: z.string().nullable(),
      }),
    )
    .parse(result.data);
  return [
    {
      kind: "records",
      totalCount: result.count,
      rows: rows.map((row) => ({
        entity: "financialTransaction",
        id: row.id,
        title: row.merchant ?? "Transaction",
        trailing: formatCurrency(row.amount),
        time: row.transactionDate
          ? { kind: "date", value: row.transactionDate }
          : undefined,
      })),
      listLink: {
        entity: "financialTransaction",
        filters: { accountId: code, dataGap: gaps.join(",") },
      },
      empty: "No transactions with booking, allocation or classification gaps.",
    },
  ];
}

import type { ReportBlock } from "@cubby/schemas/entity-report";
import { countLabel } from "@cubby/shared/pluralize";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { readExpense } from "~/server/domains/expense/repo/crud";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

export async function expenseAttributionSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "expense", code);
  const record = await readExpense(db, code);
  if (!record) throw new Error("Expense is unavailable.");
  const codes = [
    ...new Set(
      [...record.beneficiaries, ...record.funders].flatMap((row) =>
        row.partyId ? [row.partyId] : [],
      ),
    ),
  ];
  const names = new Map<string, string>();
  if (codes.length) {
    const result = await unwrapDb(db).execute(
      sql`
      SELECT "shortcode" AS id, name FROM "LedgerParty"
      WHERE "shortcode" IN (${sql.join(
        codes.map((id) => sql`${id}`),
        sql`, `,
      )}) AND ${notDeleted("LedgerParty")}
    `,
      "objects",
    );
    for (const row of z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(result))
      names.set(row.id, row.name);
  }
  return [
    { title: "Beneficiaries", values: record.beneficiaries },
    { title: "Initial funders", values: record.funders },
  ].map(({ title, values }) => ({
    kind: "records",
    title,
    totalCount: values.length,
    rows: values.map((row) => ({
      entity: row.partyId && names.has(row.partyId) ? "ledgerParty" : null,
      id: row.partyId && names.has(row.partyId) ? row.partyId : null,
      title: row.partyId
        ? (names.get(row.partyId) ?? "Unresolved party")
        : "Unattributed",
      trailing: countLabel(row.weight, "share"),
    })),
    empty: `No ${title.toLowerCase()} recorded.`,
  }));
}

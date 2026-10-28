import type { ReportBlock, ReportTime } from "@cubby/schemas/entity-report";
import type { FinancialTransactionFilters } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { financialTransactionCoverage } from "@cubby/schemas/purchase-evidence-policy";
import { sourceTransactionRecordMatchState } from "@cubby/schemas/source-transaction-record";
import { countLabel } from "@cubby/shared/pluralize";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { formatCurrency } from "~/lib/number-format";
import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted, actualExpenseSql } from "~/server/db/helpers/predicates";
import { readExpense } from "~/server/domains/expense/repo/crud";
import { financialTransactionScaffold } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { householdContributionLedger } from "~/server/domains/household-contribution/repo/reports";
import { inventoryScaffold } from "~/server/domains/inventory/repo/crud";
import { financialTransactionBookingSql } from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { sourceTransactionRecordScaffold } from "~/server/domains/transaction-import/repo/entity-repositories";
import {
  CHARGE_STATE,
  chargeKeyOf,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

const rankedRow = z.object({
  id: z.string(),
  name: z.string(),
  count: z.coerce.number().int().nonnegative(),
  total: z.coerce.number().int().nonnegative(),
  latest: z.string().nullable(),
});

/** A Purchase counts once even when several of an Ingredient's Products occur on it. */
export async function ingredientSellersSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "ingredient", code);
  const result = await unwrapDb(db).execute(sql`
    SELECT v."shortcode" AS id, v."name", count(DISTINCT p.id)::int AS count,
      count(*) OVER ()::int AS total, max(p.date)::text AS latest
    FROM "Product" product
    JOIN "Expense" e ON e."productId" = product.id AND ${notDeleted("e")}
    JOIN "Purchase" p ON p.id = e."purchaseId" AND ${notDeleted("p")}
    JOIN "Vendor" v ON v.id = p."vendorId" AND ${notDeleted("v")}
    WHERE product."ingredientId" = ${id} AND ${notDeleted("product")}
      AND ${sql.raw(actualExpenseSql("e"))}
    GROUP BY v.id, v."shortcode", v.name
    ORDER BY count(DISTINCT p.id) DESC, max(p.date) DESC NULLS LAST, v."shortcode"
    LIMIT 3
  `);
  const rows = rankedRow.array().parse(result.rows);
  return [
    {
      kind: "records",
      title: "Sellers by distinct actual Purchases",
      rows: rows.map((row) => ({
        entity: "vendor",
        id: row.id,
        title: row.name,
        trailing: countLabel(row.count, "purchase"),
        time: row.latest
          ? ({ kind: "date", value: row.latest } satisfies ReportTime)
          : undefined,
        lines: [
          { text: row.latest ? "Last purchase" : "Purchase date not recorded" },
        ],
      })),
      totalCount: rows[0]?.total ?? 0,
      connection: {
        source: { entityKind: "ingredient", entityId: code },
        viewKey: "vendors",
      },
      footer: "Ranked across linked Products; a shared Purchase counts once.",
      empty: "No actual purchases recorded for linked Products.",
    },
  ];
}

/** Seller purchase frequency is independent of the Vendor's marketed-Brand role. */
export async function vendorFrequentProductsSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "vendor", code);
  const result = await unwrapDb(db).execute(sql`
    SELECT product."shortcode" AS id, product.name,
      count(DISTINCT p.id)::int AS count, count(*) OVER ()::int AS total,
      max(p.date)::text AS latest
    FROM "Purchase" p
    JOIN "Expense" e ON e."purchaseId" = p.id AND ${notDeleted("e")}
    JOIN "Product" product ON product.id = e."productId" AND ${notDeleted("product")}
    WHERE p."vendorId" = ${id} AND ${notDeleted("p")}
      AND ${sql.raw(actualExpenseSql("e"))}
    GROUP BY product.id, product."shortcode", product.name
    ORDER BY count(DISTINCT p.id) DESC, max(p.date) DESC NULLS LAST, product."shortcode"
    LIMIT 3
  `);
  const rows = rankedRow.array().parse(result.rows);
  return [
    {
      kind: "records",
      title: "Frequently bought Products",
      rows: rows.map((row) => ({
        entity: "product",
        id: row.id,
        title: row.name,
        trailing: countLabel(row.count, "purchase"),
        time: row.latest
          ? ({ kind: "date", value: row.latest } satisfies ReportTime)
          : undefined,
      })),
      totalCount: rows[0]?.total ?? 0,
      connection: {
        source: { entityKind: "vendor", entityId: code },
        viewKey: "relation:products",
      },
      footer: "Ranked by distinct actual Purchases from this Seller.",
      empty: "No Product-linked actual purchases recorded.",
    },
  ];
}

/** Rank the Cookbook's own Recipes by their latest live Meal, without sibling attribution. */
export async function cookbookRecentRecipesSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "cookbook", code);
  const result = await unwrapDb(db).execute(sql`
    SELECT r."shortcode" AS id, r.name, count(DISTINCT m.id)::int AS count,
      count(*) OVER ()::int AS total, max(m.date)::text AS latest
    FROM "Recipe" r
    JOIN "MealRecipe" mr ON mr."recipeId" = r.id AND ${notDeleted("mr")}
    JOIN "Meal" m ON m.id = mr."mealId" AND ${notDeleted("m")}
    WHERE r."cookbookId" = ${id} AND ${notDeleted("r")}
    GROUP BY r.id, r."shortcode", r.name
    ORDER BY max(m.date) DESC NULLS LAST, r."shortcode"
    LIMIT 3
  `);
  const rows = rankedRow.array().parse(result.rows);
  return [
    {
      kind: "records",
      title: "Recipes cooked recently",
      rows: [
        ...rows.map((row) => ({
          entity: "recipe",
          id: row.id,
          title: row.name,
          trailing: countLabel(row.count, "meal"),
          time: row.latest
            ? ({ kind: "date", value: row.latest } satisfies ReportTime)
            : undefined,
        })),
        ...(rows.length
          ? [
              {
                entity: null,
                id: null,
                title: "All Recipes in this Cookbook",
                trailing: null,
                listLink: { entity: "recipe", filters: { cookbookId: code } },
              },
            ]
          : []),
      ],
      totalCount: rows[0]?.total ?? 0,
      empty: "No Meals recorded for this Cookbook's Recipes.",
    },
  ];
}

/** Contribution arithmetic remains in the household ledger, including attribution gaps. */
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

/** Count retained observations using the canonical charge-state filter, not raw transactionId. */
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
  const bookingResult = await unwrapDb(db).execute(sql`
    SELECT coverage.booking, count(*)::int AS count
    FROM (
      SELECT ${financialTransactionBookingSql("ft")} AS booking
      FROM "FinancialTransaction" ft
      WHERE ${notDeleted("ft")} AND ft.shortcode IN (
        SELECT cs.shortcode
        FROM "TransactionImportRecord" member
        JOIN "SourceTransactionRecord" r ON r.id = member."statementRowId" AND ${notDeleted("r")}
        JOIN ${CHARGE_STATE} cs ON cs.source = r.source AND cs."chargeKey" = ${chargeKeyOf("r")}
        WHERE member."importId" = ${storedImportId}::uuid
          AND NOT cs.ignored AND NOT cs.superseded AND cs.shortcode IS NOT NULL
      )
    ) coverage
    GROUP BY coverage.booking
  `);
  const bookingCounts = z
    .array(
      z.object({
        booking: financialTransactionCoverage.shape.booking,
        count: z.coerce.number().int().nonnegative(),
      }),
    )
    .parse(bookingResult.rows);
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
      figures: counts.map(({ state, count }) => ({
        label: state.charAt(0).toUpperCase() + state.slice(1),
        value: count,
        format: "count",
      })),
    },
    {
      kind: "note",
      text: "Counts describe retained provider observations, not unique charges or spending. Intake completion and reconciliation are separate.",
    },
    {
      kind: "stats",
      title: "Matched transaction booking",
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

/** The existing owner filter includes acquisition-inherited ownership. */
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
    projection: selectedListProjection("inventory", ["id", "displayName"]),
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

/** Attribution weights describe recorded shares; they are not a second money ledger. */
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
    const result = await unwrapDb(db).execute(sql`
      SELECT "shortcode" AS id, name FROM "LedgerParty"
      WHERE "shortcode" IN (${sql.join(
        codes.map((id) => sql`${id}`),
        sql`, `,
      )}) AND ${notDeleted("LedgerParty")}
    `);
    for (const row of z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(result.rows))
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

/** Review coverage comes from the same named data gaps as the account's transaction list. */
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
    projection: selectedListProjection("financialTransaction", [
      "id",
      "merchant",
      "amount",
      "transactionDate",
    ]),
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

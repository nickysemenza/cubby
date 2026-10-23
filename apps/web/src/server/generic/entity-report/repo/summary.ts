import type { ConnectedRecordsOutput } from "@cubby/schemas/connected-records";
import { emailOut } from "@cubby/schemas/email";
import type { ReportBlock } from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProductId } from "@cubby/schemas/identifiers";
import { productPricingOut } from "@cubby/schemas/product-fields";
import { countLabel } from "@cubby/shared/pluralize";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { listEmailsRead } from "~/server/domains/email/repo/email";
import { listProductsRead } from "~/server/domains/product/repo/crud";
import { listSourceTransactionRecordsRead } from "~/server/domains/transaction-import/repo/entity-repositories";
import { getConnectedRecords } from "~/server/generic/entity-links/repo/connected-records";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

const sellerRow = z.object({
  id: z.string(),
  name: z.string(),
  count: z.coerce.number(),
  sellerCount: z.coerce.number(),
  lastPurchase: z.string().nullable(),
});

/** Count purchases once even when several actual lines name the same Product. */
export async function productSellersReport(
  db: Database,
  productId: ProductId,
  code: string,
): Promise<ReportBlock[]> {
  const result = await unwrapDb(db).execute(sql`
    SELECT v."shortcode" AS id, v."name", count(DISTINCT p."id")::int AS count, count(*) OVER ()::int AS "sellerCount",
      max(p."date")::text AS "lastPurchase"
    FROM "Expense" e
    JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
    JOIN "Vendor" v ON v."id" = p."vendorId" AND v."deletedAt" IS NULL
    WHERE e."productId" = ${productId} AND e."deletedAt" IS NULL AND ${sql.raw(actualExpenseSql("e"))}
    GROUP BY v."id", v."shortcode", v."name"
    ORDER BY count(DISTINCT p."id") DESC, max(p."date") DESC NULLS LAST, v."shortcode" ASC
    LIMIT 3
  `);
  const rows = z.array(sellerRow).parse(result.rows);
  return [
    {
      kind: "records",
      rows: rows.map((row) => ({
        entity: "vendor",
        id: row.id,
        title: row.name,
        trailing: countLabel(row.count, "purchase"),
        time: row.lastPurchase
          ? { kind: "date", value: row.lastPurchase }
          : undefined,
        lines: [
          {
            text: row.lastPurchase
              ? "Last purchase"
              : "Purchase date not recorded",
          },
        ],
      })),
      totalCount: rows[0]?.sellerCount ?? 0,
      listLink: { entity: "vendor", filters: { productId: code } },
      footer: rows[0]
        ? `Top ${rows.length} of ${rows[0].sellerCount} sellers by distinct actual Purchases`
        : undefined,
      empty: "No actual purchases recorded.",
    },
  ];
}

function connectedBlock(
  title: string,
  records: ConnectedRecordsOutput,
  source: { entityKind: "product"; entityId: string },
  viewKey: string,
): ReportBlock {
  return {
    kind: "records",
    title,
    connection: { source, viewKey },
    rows: records.items.map(({ target, paths }) => ({
      paths,
      entity: target.entityKind,
      id: target.entityId,
      title: target.label,
      trailing: null,
    })),
    totalCount: records.totalCount,
    footer: `${records.totalCount} total`,
    empty: "No records.",
  };
}

export async function productStockSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "product", code);
  const [products, locations] = await Promise.all([
    listProductsRead(
      db,
      { ids: [parseShortcodeFor("product", code)] },
      [],
      { pageIndex: 0, pageSize: 1 },
      "page",
      undefined,
      selectedListProjection("product", ["id", "onHandUnits"]),
    ),
    getConnectedRecords(db, {
      source: { entityKind: "product", entityId: code },
      viewKey: "relation:locations",
      limit: 3,
    }),
  ]);
  const product = z
    .object({ onHandUnits: z.number().nullable() })
    .parse(products.data[0]);
  return [
    {
      kind: "stats",
      figures: [
        {
          label: "Estimated units on hand",
          value: product.onHandUnits,
          format: "count",
        },
      ],
    },
    connectedBlock(
      "Stocked locations",
      locations,
      { entityKind: "product", entityId: code },
      "relation:locations",
    ),
    {
      kind: "note",
      text: "Inventory is approximate; unknown quantities remain unknown.",
    },
  ];
}

export async function productContextSummary(
  db: Database,
  code: string,
  kind: "uses" | "evidence",
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "product", code);
  const views =
    kind === "uses"
      ? [
          { key: "recipes", title: "Recipes" },
          { key: "relation:tasks", title: "Subject Tasks" },
          { key: "relation:components", title: "Kit components" },
          { key: "relation:containing-kits", title: "Containing kits" },
        ]
      : [
          { key: "source-documents", title: "Purchase documents" },
          { key: "source-emails", title: "Related Emails" },
        ];
  const records = await Promise.all(
    views.map(async (view) => ({
      view,
      records: await getConnectedRecords(db, {
        source: { entityKind: "product", entityId: code },
        viewKey: view.key,
        limit: 3,
      }),
    })),
  );
  const blocks = records
    .filter(({ records }) => records.totalCount > 0)
    .map(({ view, records }) =>
      connectedBlock(
        view.title,
        records,
        { entityKind: "product", entityId: code },
        view.key,
      ),
    );
  if (blocks.length && kind === "evidence")
    blocks.push({
      kind: "note",
      text: "Related evidence does not verify every field.",
    });
  return blocks;
}

/** Derived relations use their canonical scoped list readers, without inventing graph paths. */
export async function emailSummary(
  db: Database,
  code: string,
  entity: "vendor" | "vendorAccount",
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, entity, code);
  const result = await listEmailsRead(
    db,
    entity === "vendor"
      ? { vendorId: [parseShortcodeFor("vendor", code)] }
      : { vendorAccountId: [parseShortcodeFor("vendorAccount", code)] },
    [{ orderBy: "receivedAt", direction: "desc" }],
    { pageIndex: 0, pageSize: 3 },
    selectedListProjection("email", ["id", "subject", "receivedAt"]),
  );
  const rows = z
    .array(emailOut.pick({ id: true, subject: true, receivedAt: true }))
    .parse(result.data);
  return [
    {
      kind: "records",
      rows: rows.map((row) => ({
        entity: "email",
        id: row.id,
        title: row.subject ?? "Email without a subject",
        trailing: null,
        at: row.receivedAt?.toISOString(),
      })),
      totalCount: result.count,
      listLink: {
        entity: "email",
        filters:
          entity === "vendor" ? { vendorId: code } : { vendorAccountId: code },
      },
      footer: `${result.count} total`,
      empty: "No related Emails.",
    },
  ];
}

export async function transactionSourcesSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "financialTransaction", code);
  const result = await listSourceTransactionRecordsRead(
    db,
    { transactionId: [parseShortcodeFor("financialTransaction", code)] },
    [],
    { pageIndex: 0, pageSize: 3 },
    selectedListProjection("sourceTransactionRecord", [
      "id",
      "displayName",
      "source",
      "statementDate",
    ]),
  );
  const rows = z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        source: z.string(),
        statementDate: z.string().nullable(),
      }),
    )
    .parse(result.data);
  return [
    {
      kind: "records",
      rows: rows.map((row) => ({
        entity: "sourceTransactionRecord",
        id: row.id,
        title: row.displayName,
        trailing: row.statementDate,
        lines: [{ text: row.source }],
      })),
      totalCount: result.count,
      listLink: {
        entity: "sourceTransactionRecord",
        filters: { transactionId: code },
      },
      footer: `${result.count} total`,
      empty: "No source observations.",
    },
  ];
}

export async function productPricingSummary(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "product", code);
  // Exact ids are canonical shortcodes; Product declares no static list scope. Saved-view
  // defaults are UI filters and are not applied to this explicit repository request.
  const result = await listProductsRead(
    db,
    { ids: [parseShortcodeFor("product", code)] },
    [],
    { pageIndex: 0, pageSize: 1 },
    "page",
    undefined,
    selectedListProjection("product", [
      "id",
      "purchaseDate",
      "unitPriceLabel",
      "pricing",
    ]),
  );
  const row = z
    .object({
      purchaseDate: z.string().nullable(),
      unitPriceLabel: z.string().nullish(),
      pricing: productPricingOut,
    })
    .parse(result.data[0]);
  return [
    {
      kind: "records",
      empty: "",
      rows: [
        {
          entity: null,
          id: null,
          title: "Latest actual purchase",
          time: row.purchaseDate
            ? { kind: "date", value: row.purchaseDate }
            : undefined,
          trailing: row.unitPriceLabel ?? "Unit price unknown",
          lines: [
            {
              text: row.purchaseDate
                ? "Current unit price; may differ from the last receipt."
                : "Purchase date not recorded.",
            },
          ],
        },
      ],
    },
    {
      kind: "note",
      text: `Price source: ${row.pricing.source}. ${row.pricing.knownExpenseCount} priced Expenses; ${row.pricing.unknownExpenseCount} unpriced.`,
    },
    ...(row.pricing.partial
      ? [
          {
            kind: "note" as const,
            text: "Price coverage is incomplete.",
            tone: "warning" as const,
          },
        ]
      : []),
  ];
}

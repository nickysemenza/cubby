import "dotenv/config";
import { Client } from "pg";

/**
 * Read-only evidence manifest for the historical Expense.productQuantity
 * reconciliation. It deliberately proposes no quantities and performs no
 * writes: notes/PDFs are evidence for an operator to review, not permission to
 * infer counts automatically.
 *
 * Usage:
 *   pnpm --filter @cubby/web db:report-product-quantities
 *   pnpm --filter @cubby/web db:report-product-quantities -- --limit=50
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to report product quantities.");
  process.exit(1);
}

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const parsedLimit = limitArg
  ? Number.parseInt(limitArg.slice("--limit=".length), 10)
  : 0;
if (!Number.isInteger(parsedLimit) || parsedLimit < 0 || parsedLimit > 500) {
  console.error("--limit must be a whole number from 0 to 500.");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");

  const summary = await client.query<{
    candidateExpenses: number;
    candidateProducts: number;
    quantified: number;
    unknown: number;
    unknownWithNotes: number;
    unknownWithPdf: number;
    unknownWithQuantityHint: number;
    unknownWithEvidence: number;
    unknownWithoutInlineEvidence: number;
  }>(`
    WITH candidates AS (
      SELECT
        e."productId",
        e."productQuantity",
        nullif(btrim(coalesce(e."notes", '')), '') IS NOT NULL AS has_notes,
        concat_ws(' ', e."name", e."notes") ~*
          '(qty|quantity|[0-9]+[[:space:]]*[x×]|x[[:space:]]*[0-9]+|pack of|set of)' AS has_quantity_hint,
        EXISTS (
          SELECT 1
          FROM "PurchaseImage" pi
          JOIN "Image" i
            ON i."id" = pi."imageId"
           AND i."deletedAt" IS NULL
          WHERE pi."purchaseId" = e."purchaseId"
            AND pi."deletedAt" IS NULL
            AND i."contentType" = 'application/pdf'
        ) AS has_pdf
      FROM "Expense" e
      WHERE e."deletedAt" IS NULL
        AND e."productId" IS NOT NULL
        AND e."future" = false
        AND e."cost" > 0
    )
    SELECT
      count(*)::int AS "candidateExpenses",
      count(DISTINCT "productId")::int AS "candidateProducts",
      count(*) FILTER (WHERE "productQuantity" IS NOT NULL)::int AS quantified,
      count(*) FILTER (WHERE "productQuantity" IS NULL)::int AS unknown,
      count(*) FILTER (
        WHERE "productQuantity" IS NULL AND has_notes
      )::int AS "unknownWithNotes",
      count(*) FILTER (
        WHERE "productQuantity" IS NULL AND has_pdf
      )::int AS "unknownWithPdf",
      count(*) FILTER (
        WHERE "productQuantity" IS NULL AND has_quantity_hint
      )::int AS "unknownWithQuantityHint",
      count(*) FILTER (
        WHERE "productQuantity" IS NULL AND (has_notes OR has_pdf)
      )::int AS "unknownWithEvidence",
      count(*) FILTER (
        WHERE "productQuantity" IS NULL AND NOT has_notes AND NOT has_pdf
      )::int AS "unknownWithoutInlineEvidence"
    FROM candidates
  `);

  const candidates =
    parsedLimit === 0
      ? []
      : (
          await client.query(
            `
              SELECT
                e."shortcode" AS "expenseId",
                p."shortcode" AS "productId",
                p."name" AS "productName",
                e."name" AS "expenseName",
                e."cost",
                e."date",
                v."name" AS "vendor",
                pu."orderId",
                e."notes",
                (concat_ws(' ', e."name", e."notes") ~* '(qty|quantity|[0-9]+[[:space:]]*[x×]|x[[:space:]]*[0-9]+|pack of|set of)') AS "hasQuantityHint",
                (regexp_match(
                  concat_ws(' ', e."name", e."notes"),
                  '[(]qty[[:space:]]+([0-9]+)[)]',
                  'i'
                ))[1] AS "explicitQuantityToken",
                coalesce(docs.documents, '[]'::json) AS documents
              FROM "Expense" e
              JOIN "Product" p
                ON p."id" = e."productId"
               AND p."deletedAt" IS NULL
              LEFT JOIN "Purchase" pu
                ON pu."id" = e."purchaseId"
               AND pu."deletedAt" IS NULL
              LEFT JOIN "Vendor" v
                ON v."id" = pu."vendorId"
               AND v."deletedAt" IS NULL
              LEFT JOIN LATERAL (
                SELECT json_agg(
                  json_build_object(
                    'filename', i."filename",
                    'url', i."url"
                  ) ORDER BY i."createdAt"
                ) AS documents
                FROM "PurchaseImage" pi
                JOIN "Image" i
                  ON i."id" = pi."imageId"
                 AND i."deletedAt" IS NULL
                WHERE pi."purchaseId" = e."purchaseId"
                  AND pi."deletedAt" IS NULL
                  AND i."contentType" = 'application/pdf'
              ) docs ON true
              WHERE e."deletedAt" IS NULL
                AND e."productId" IS NOT NULL
                AND e."future" = false
                AND e."cost" > 0
                AND e."productQuantity" IS NULL
              ORDER BY
                ((regexp_match(
                  concat_ws(' ', e."name", e."notes"),
                  '[(]qty[[:space:]]+([0-9]+)[)]',
                  'i'
                ))[1] IS NOT NULL) DESC,
                (concat_ws(' ', e."name", e."notes") ~* '(qty|quantity|[0-9]+[[:space:]]*[x×]|x[[:space:]]*[0-9]+|pack of|set of)') DESC,
                (coalesce(json_array_length(docs.documents), 0) > 0) DESC,
                e."date" DESC,
                e."shortcode"
              LIMIT $1
            `,
            [parsedLimit],
          )
        ).rows;

  await client.query("ROLLBACK");
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        summary: summary.rows[0],
        candidates,
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}

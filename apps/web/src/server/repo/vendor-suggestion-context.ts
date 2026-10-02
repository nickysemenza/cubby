import { createHash } from "node:crypto";

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { categoryMappingSchema } from "@cubby/schemas/spending-classification";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";

import { categoryMappingSql } from "./category-connections";
import { unwrapDb } from "./database-helpers";
import { resolveOrThrow } from "./shortcode-resolver";

const rootSchema = z.object({
  name: z.string(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  spendingProfile: z.string(),
  defaultSpendingCategoryId: z.string().nullable(),
});
const lineSchema = z.object({
  shortcode: z.string(),
  name: z.string(),
  cost: z.number(),
  purchase: z.string(),
  product: z.string().nullable(),
  productName: z.string().nullable(),
  productCategoryId: z.string().nullable(),
  productCategory: z.string().nullable(),
  productCategoryEmoji: z.string().nullable(),
  mapping: categoryMappingSchema.nullable(),
  explicitSpendingCategory: z.string().nullable(),
  purchaseSpendingCategory: z.string().nullable(),
  economicRole: z.string(),
});

/** Authoritative saved evidence deliberately excludes vendor-resolved category summaries. */
export async function loadVendorSuggestionContext(
  db: Database | DrizzleTransaction,
  code: string,
) {
  const id = await resolveOrThrow(db, "vendor", code);
  const database = unwrapDb(db);
  const roots = await database.execute(
    sql`SELECT name, website, notes, "spendingProfile", "defaultSpendingCategoryId" FROM "Vendor" WHERE id=${id} AND "deletedAt" IS NULL`,
  );
  const root = rootSchema.parse(roots.rows[0]);
  const rows =
    await database.execute(sql`SELECT e.shortcode,e.name,e.cost,p.shortcode AS purchase,g.shortcode AS product,g.name AS "productName",pc.shortcode AS "productCategoryId",pc.name AS "productCategory",pc.emoji AS "productCategoryEmoji",
    CASE WHEN pc.id IS NULL THEN NULL ELSE ${categoryMappingSql(sql`pc.id`)} END AS mapping,
    sc.name AS "explicitSpendingCategory",psc.name AS "purchaseSpendingCategory",e."economicRole"
    FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" AND p."deletedAt" IS NULL
    LEFT JOIN "Product" g ON g.id=e."productId" AND g."deletedAt" IS NULL
    LEFT JOIN "ProductCategory" pc ON pc.id=g."categoryId" AND pc."deletedAt" IS NULL
    LEFT JOIN "SpendingCategory" sc ON sc.id=e."spendingCategoryId" AND sc."deletedAt" IS NULL
    LEFT JOIN "SpendingCategory" psc ON psc.id=p."spendingCategoryId" AND p."spendingCategoryOrigin" <> 'source' AND psc."deletedAt" IS NULL
    WHERE p."vendorId"=${id} AND e."deletedAt" IS NULL AND e."lineKind"='principal'
    ORDER BY e.shortcode LIMIT 201`);
  const lines = z.array(lineSchema).parse(rows.rows);
  const categories = (
    await database.execute(
      sql`SELECT shortcode,name,"parentId",emoji FROM "SpendingCategory" WHERE "deletedAt" IS NULL ORDER BY shortcode`,
    )
  ).rows;
  const truncated = lines.length > 200;
  const subject = JSON.stringify({
    savedVendor: root,
    principalLines: lines.slice(0, 200),
    truncated,
    evidenceRule:
      "Explicit line and purchase categories and ProductCategory mappings are independent evidence. The saved vendor default and profile are review targets, never evidence proving themselves. Costs retain their signs; refunds, reimbursements and adjustments are not new purchased goods.",
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ subject, categories }))
    .digest("hex");
  const groups = new Map<
    string,
    {
      id: string;
      name: string;
      emoji: string | null;
      principalLineCount: number;
      purchases: Set<string>;
    }
  >();
  for (const line of lines.slice(0, 200)) {
    if (!line.productCategoryId) continue;
    const group = groups.get(line.productCategoryId) ?? {
      id: line.productCategoryId,
      name:
        line.mapping?.path ?? line.productCategory ?? line.productCategoryId,
      emoji: line.productCategoryEmoji,
      principalLineCount: 0,
      purchases: new Set<string>(),
    };
    group.principalLineCount++;
    group.purchases.add(line.purchase);
    groups.set(group.id, group);
  }
  return {
    subject,
    fingerprint,
    lines: lines.slice(0, 200),
    truncated,
    hasSignal: lines.length > 0 || !!root.name,
    basis: {
      name: root.name,
      website: root.website,
      notes: root.notes,
      spendingProfile: root.spendingProfile,
    },
    groups: [...groups.values()].map(({ purchases, ...group }) => ({
      ...group,
      name: `${group.name} · ${group.principalLineCount} lines / ${purchases.size} purchases`,
      distinctPurchaseCount: purchases.size,
    })),
    unknownLineCount: lines
      .slice(0, 200)
      .filter((line) => !line.productCategoryId).length,
  };
}

/** Full coverage for the evidence breakdown; the AI's bounded sample never supplies these totals. */
export async function loadVendorCategoryEvidence(
  db: Database | DrizzleTransaction,
  code: string,
) {
  const id = await resolveOrThrow(db, "vendor", code);
  const rows = await unwrapDb(db)
    .execute(sql`SELECT pc.shortcode AS id,pc.emoji,
    CASE WHEN pc.id IS NULL THEN NULL ELSE ${categoryMappingSql(sql`pc.id`)}->>'path' END AS name,
    count(*)::int AS "principalLineCount",count(DISTINCT p.id)::int AS "distinctPurchaseCount"
    FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" AND p."deletedAt" IS NULL
    LEFT JOIN "Product" g ON g.id=e."productId" AND g."deletedAt" IS NULL
    LEFT JOIN "ProductCategory" pc ON pc.id=g."categoryId" AND pc."deletedAt" IS NULL
    WHERE p."vendorId"=${id} AND e."deletedAt" IS NULL AND e."lineKind"='principal'
    GROUP BY pc.id,pc.shortcode,pc.emoji ORDER BY pc.shortcode NULLS LAST`);
  const evidence = z
    .array(
      z.object({
        id: z.string().nullable(),
        name: z.string().nullable(),
        emoji: z.string().nullable(),
        principalLineCount: z.number(),
        distinctPurchaseCount: z.number(),
      }),
    )
    .parse(rows.rows);
  return {
    purchasedCategories: evidence.flatMap((group) =>
      group.id
        ? [
            {
              ...group,
              id: parseShortcodeFor("productCategory", group.id),
              name: `${group.name} · ${group.principalLineCount} lines / ${group.distinctPurchaseCount} purchases`,
            },
          ]
        : [],
    ),
    principalLineCount: evidence.reduce(
      (sum, group) => sum + group.principalLineCount,
      0,
    ),
    unknownCategoryLineCount:
      evidence.find((group) => group.id === null)?.principalLineCount ?? 0,
  };
}

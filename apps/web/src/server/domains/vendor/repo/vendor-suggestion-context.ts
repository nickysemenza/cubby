import { createHash } from "node:crypto";

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { categoryMappingSchema } from "@cubby/schemas/spending-classification";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { outer } from "~/server/db/helpers/related";
import {
  expense,
  product,
  productCategory,
  purchase,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import { categoryMappingSql } from "~/server/domains/product-category/repo/category-connections";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

/** Authoritative saved evidence deliberately excludes vendor-resolved category summaries. */
export async function loadVendorSuggestionContext(
  db: Database | DrizzleTransaction,
  code: string,
) {
  const id = await resolveOrThrow(db, "vendor", code);
  const database = unwrapDb(db);
  const [root] = await database
    .select({
      name: vendor.name,
      website: vendor.website,
      notes: vendor.notes,
      spendingProfile: vendor.spendingProfile,
      defaultSpendingCategoryId: vendor.defaultSpendingCategoryId,
    })
    .from(vendor)
    .where(and(eq(vendor.id, id), notDeleted(vendor)));
  if (!root) throw new Error(`Vendor ${code} was not found`);
  const lineCategory = alias(spendingCategory, "lineSpendingCategory");
  const purchaseCategory = alias(spendingCategory, "purchaseSpendingCategory");
  const rows = await database
    .select({
      shortcode: expense.shortcode,
      name: expense.name,
      cost: expense.cost,
      purchase: purchase.shortcode,
      product: product.shortcode,
      productName: product.name,
      productCategoryId: productCategory.shortcode,
      productCategory: productCategory.name,
      productCategoryEmoji: productCategory.emoji,
      mapping: sql<unknown>`CASE WHEN ${productCategory.id} IS NULL THEN NULL ELSE ${categoryMappingSql(outer(productCategory.id))} END`,
      explicitSpendingCategory: lineCategory.name,
      purchaseSpendingCategory: purchaseCategory.name,
      economicRole: expense.economicRole,
    })
    .from(expense)
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .leftJoin(
      product,
      and(eq(product.id, expense.productId), notDeleted(product)),
    )
    .leftJoin(
      productCategory,
      and(
        eq(productCategory.id, product.categoryId),
        notDeleted(productCategory),
      ),
    )
    .leftJoin(
      lineCategory,
      and(
        eq(lineCategory.id, expense.spendingCategoryId),
        notDeleted(lineCategory),
      ),
    )
    .leftJoin(
      purchaseCategory,
      and(
        eq(purchaseCategory.id, purchase.spendingCategoryId),
        ne(purchase.spendingCategoryOrigin, "source"),
        notDeleted(purchaseCategory),
      ),
    )
    .where(
      and(
        eq(purchase.vendorId, id),
        notDeleted(expense),
        eq(expense.lineKind, "principal"),
      ),
    )
    .orderBy(asc(expense.shortcode))
    .limit(201);
  const lines = rows.map((row) => ({
    ...row,
    mapping: categoryMappingSchema.nullable().parse(row.mapping),
  }));
  const categories = await database
    .select({
      shortcode: spendingCategory.shortcode,
      name: spendingCategory.name,
      parentId: spendingCategory.parentId,
      emoji: spendingCategory.emoji,
    })
    .from(spendingCategory)
    .where(notDeleted(spendingCategory))
    .orderBy(asc(spendingCategory.shortcode));
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
  id: string,
) {
  const rows = await unwrapDb(db).execute(
    sql`SELECT pc.shortcode AS id,pc.emoji,
    CASE WHEN pc.id IS NULL THEN NULL ELSE ${categoryMappingSql(sql`pc.id`)}->>'path' END AS name,
    count(*)::int AS "principalLineCount",count(DISTINCT p.id)::int AS "distinctPurchaseCount"
    FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" AND ${notDeleted("p")}
    LEFT JOIN "Product" g ON g.id=e."productId" AND ${notDeleted("g")}
    LEFT JOIN "ProductCategory" pc ON pc.id=g."categoryId" AND ${notDeleted("pc")}
    WHERE p."vendorId"=${id} AND ${notDeleted("e")} AND e."lineKind"='principal'
    GROUP BY pc.id,pc.shortcode,pc.emoji ORDER BY pc.shortcode NULLS LAST`,
    "objects",
  );
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
    .parse(rows);
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

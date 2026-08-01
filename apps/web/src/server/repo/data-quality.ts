import type { ActorContext } from "@cubby/schemas/context";
import {
  type ClearDataExceptionInput,
  type DataCheck,
  type DataException,
  type DataQuality,
  type DataQualityException,
  type DataQualityGap,
  type ProductDataCheck,
  type PurchaseDataCheck,
  productDataCheck,
  purchaseDataCheck,
  type SetDataExceptionInput,
} from "@cubby/schemas/data-quality";
import type { ProductId, PurchaseId } from "@cubby/schemas/identifiers";
import {
  unsafeProductId,
  unsafeProductShortcode,
  unsafePurchaseId,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import {
  primaryPurchaseDocumentKinds,
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
} from "@cubby/schemas/purchase";
import { parseShortcode, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { and, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { groupBy, uniq, uniqBy } from "es-toolkit";
import type { Database } from "~/server/db";
import {
  expense,
  financialTransaction,
  image,
  product,
  productExternalId,
  purchase,
  purchaseImage,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

const AMAZON_SOURCE = "amazon";

const externalIdCollisionKey = (value: {
  source: string;
  kind: string;
  externalId: string;
}) =>
  `${value.source.trim().toLowerCase()}\u0000${value.kind}\u0000${value.externalId}`;

const hasException = (
  column: typeof product.dataExceptions | typeof purchase.dataExceptions,
  check: DataCheck,
): SQL => sql`${column} @> ${JSON.stringify([{ check }])}::jsonb`;

const productHasExpenses = sql`EXISTS (
  SELECT 1 FROM "Expense" dq_e
  WHERE dq_e."productId" = ${product.id} AND dq_e."deletedAt" IS NULL
)`;

const productHasAmazonPurchase = sql`EXISTS (
  SELECT 1
  FROM "Expense" dq_ae
  JOIN "Purchase" dq_ap ON dq_ap."id" = dq_ae."purchaseId" AND dq_ap."deletedAt" IS NULL
  JOIN "Vendor" dq_av ON dq_av."id" = dq_ap."vendorId" AND dq_av."deletedAt" IS NULL
  WHERE dq_ae."productId" = ${product.id}
    AND dq_ae."deletedAt" IS NULL
    AND lower(dq_av."name") LIKE 'amazon%'
)`;

const productHasAmazonId = sql`EXISTS (
  SELECT 1 FROM "ProductExternalId" dq_asin
  WHERE dq_asin."productId" = ${product.id}
    AND dq_asin."deletedAt" IS NULL
    AND lower(dq_asin."source") = ${AMAZON_SOURCE}
)`;

const productHasExternalIdCollision = sql`EXISTS (
  SELECT 1
  FROM "ProductExternalId" dq_mine
  JOIN "ProductExternalId" dq_other
    ON lower(dq_other."source") = lower(dq_mine."source")
   AND dq_other."kind" = dq_mine."kind"
   AND dq_other."externalId" = dq_mine."externalId"
   AND dq_other."productId" <> dq_mine."productId"
   AND dq_other."deletedAt" IS NULL
  JOIN "Product" dq_other_product
    ON dq_other_product."id" = dq_other."productId"
   AND dq_other_product."deletedAt" IS NULL
  WHERE dq_mine."productId" = ${product.id}
    AND dq_mine."deletedAt" IS NULL
)`;

export const productDataGapCondition = (check: ProductDataCheck): SQL => {
  const missing =
    check === "product_manufacturer"
      ? sql`(trim(${product.manufacturer}) = '' OR lower(trim(${product.manufacturer})) = lower(${UNSPECIFIED_MANUFACTURER}))`
      : check === "product_category"
        ? sql`${product.category} IS NULL`
        : check === "product_model"
          ? sql`(${product.model} IS NULL OR trim(${product.model}) = '')`
          : check === "amazon_asin"
            ? sql`${productHasAmazonPurchase} AND NOT ${productHasAmazonId}`
            : productHasExternalIdCollision;
  return sql`${productHasExpenses} AND ${missing} AND NOT ${hasException(product.dataExceptions, check)}`;
};

export const productNeedsDataCondition = (): SQL =>
  sql`(${sql.join(
    productDataCheck.options.map((check) => productDataGapCondition(check)),
    sql` OR `,
  )})`;

const jsonExceptionAbsentRaw = (alias: string, check: DataCheck) =>
  `NOT ${alias}."dataExceptions" @> '${JSON.stringify([{ check }]).replaceAll("'", "''")}'::jsonb`;

const purchaseProductGapRaw = (check: ProductDataCheck): string => {
  const exceptionAbsent = jsonExceptionAbsentRaw("dq_pr", check);
  const base = `
    EXISTS (
      SELECT 1 FROM "Expense" dq_pe
      JOIN "Product" dq_pr ON dq_pr."id" = dq_pe."productId" AND dq_pr."deletedAt" IS NULL
      WHERE dq_pe."purchaseId" = "Purchase"."id"
        AND dq_pe."deletedAt" IS NULL
        AND dq_pe."productId" IS NOT NULL`;
  const condition =
    check === "product_manufacturer"
      ? `AND (trim(dq_pr."manufacturer") = '' OR lower(trim(dq_pr."manufacturer")) = lower('${UNSPECIFIED_MANUFACTURER}'))`
      : check === "product_category"
        ? `AND dq_pr."category" IS NULL`
        : check === "product_model"
          ? `AND (dq_pr."model" IS NULL OR trim(dq_pr."model") = '')`
          : check === "amazon_asin"
            ? `AND EXISTS (
                 SELECT 1 FROM "Expense" dq_ae
                 JOIN "Purchase" dq_ap ON dq_ap."id" = dq_ae."purchaseId" AND dq_ap."deletedAt" IS NULL
                 JOIN "Vendor" dq_av ON dq_av."id" = dq_ap."vendorId" AND dq_av."deletedAt" IS NULL
                 WHERE dq_ae."productId" = dq_pr."id" AND dq_ae."deletedAt" IS NULL
                   AND lower(dq_av."name") LIKE 'amazon%'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "ProductExternalId" dq_asin
                 WHERE dq_asin."productId" = dq_pr."id" AND dq_asin."deletedAt" IS NULL
                   AND lower(dq_asin."source") = 'amazon'
               )`
            : `AND EXISTS (
                 SELECT 1 FROM "ProductExternalId" dq_mine
                 JOIN "ProductExternalId" dq_other
                   ON dq_other."source" = dq_mine."source"
                  AND dq_other."externalId" = dq_mine."externalId"
                  AND dq_other."productId" <> dq_mine."productId"
                  AND dq_other."deletedAt" IS NULL
                 JOIN "Product" dq_other_product
                   ON dq_other_product."id" = dq_other."productId"
                  AND dq_other_product."deletedAt" IS NULL
                 WHERE dq_mine."productId" = dq_pr."id" AND dq_mine."deletedAt" IS NULL
               )`;
  return `${base} ${condition} AND ${exceptionAbsent})`;
};

const purchaseGapRaw = (check: PurchaseDataCheck): string => {
  const exceptionAbsent = jsonExceptionAbsentRaw('"Purchase"', check);
  if (check === "purchase_date") {
    return `("Purchase"."date" IS NULL AND ${exceptionAbsent})`;
  }
  if (check === "order_id") {
    return `("Purchase"."orderId" IS NULL AND ${exceptionAbsent})`;
  }
  if (check === "stated_total") {
    return `("Purchase"."statedTotal" IS NULL AND ${exceptionAbsent})`;
  }
  if (check === "primary_document") {
    const kinds = primaryPurchaseDocumentKinds
      .map((kind) => `'${kind}'`)
      .join(", ");
    return `(NOT EXISTS (
      SELECT 1 FROM "PurchaseImage" dq_pi
      JOIN "Image" dq_i ON dq_i."id" = dq_pi."imageId" AND dq_i."deletedAt" IS NULL
      WHERE dq_pi."purchaseId" = "Purchase"."id" AND dq_pi."deletedAt" IS NULL
        AND dq_pi."documentKind" IN (${kinds})
    ) AND ${exceptionAbsent})`;
  }
  if (check === "empty_expenses") {
    return `(NOT EXISTS (
      SELECT 1 FROM "Expense" dq_e
      WHERE dq_e."purchaseId" = "Purchase"."id" AND dq_e."deletedAt" IS NULL
    ) AND ${exceptionAbsent})`;
  }
  if (check === "unpriced_expense") {
    return `(EXISTS (
      SELECT 1 FROM "Expense" dq_e
      WHERE dq_e."purchaseId" = "Purchase"."id" AND dq_e."deletedAt" IS NULL
        AND dq_e."cost" IS NULL
    ) AND ${exceptionAbsent})`;
  }
  if (check === "paperwork_mismatch") {
    const tolerance = Math.round(RECONCILIATION_TOLERANCE * 100);
    const expenseCents = `floor((COALESCE((SELECT sum(dq_e."cost") FROM "Expense" dq_e
      WHERE dq_e."purchaseId" = "Purchase"."id" AND dq_e."deletedAt" IS NULL), 0) * 100)::numeric + 0.5)`;
    const statedCents = `floor(("Purchase"."statedTotal" * 100)::numeric + 0.5)`;
    const deltaCents = `(${expenseCents} - ${statedCents})`;
    const refundCents = `floor((COALESCE((SELECT sum(dq_ft."amount") FROM "FinancialTransaction" dq_ft
      WHERE dq_ft."purchaseId" = "Purchase"."id"
        AND dq_ft."kind" = 'refund' AND dq_ft."status" = 'posted'
        AND dq_ft."deletedAt" IS NULL), 0) * 100)::numeric + 0.5)`;
    const fullyPriced = `NOT EXISTS (SELECT 1 FROM "Expense" dq_unpriced
      WHERE dq_unpriced."purchaseId" = "Purchase"."id"
        AND dq_unpriced."cost" IS NULL AND dq_unpriced."deletedAt" IS NULL)`;
    const refundAdjusted = `(${fullyPriced} AND ${deltaCents} < ${-tolerance}
      AND ${refundCents} = ${deltaCents})`;
    return `("Purchase"."statedTotal" IS NOT NULL
      AND abs(${deltaCents}) > ${tolerance}
      AND NOT ${refundAdjusted}
      AND ${exceptionAbsent})`;
  }
  return `(NOT EXISTS (
    SELECT 1 FROM "FinancialTransaction" dq_ft
    WHERE dq_ft."purchaseId" = "Purchase"."id"
      AND dq_ft."deletedAt" IS NULL
      AND dq_ft."status" = 'posted'
      AND jsonb_array_length(dq_ft."sourceRefs") > 0
  ) AND ${exceptionAbsent})`;
};

export const purchaseDataGapCondition = (check: DataCheck): SQL =>
  sql.raw(
    purchaseDataCheck.safeParse(check).success
      ? purchaseGapRaw(check as PurchaseDataCheck)
      : purchaseProductGapRaw(check as ProductDataCheck),
  );

export const purchaseNeedsDataCondition = (): SQL =>
  sql.raw(
    `(${[...purchaseDataCheck.options, ...productDataCheck.options]
      .map((check) =>
        purchaseDataCheck.safeParse(check).success
          ? purchaseGapRaw(check as PurchaseDataCheck)
          : purchaseProductGapRaw(check as ProductDataCheck),
      )
      .join(" OR ")})`,
  );

const complete = (
  gaps: DataQualityGap[],
  exceptions: DataQualityException[],
): DataQuality => ({
  status: gaps.length === 0 ? "complete" : "needs_data",
  gaps,
  exceptions,
});

const hasStoredException = (
  exceptions: DataException[],
  check: DataCheck,
): boolean => exceptions.some((exception) => exception.check === check);

const targetExceptions = (
  exceptions: DataException[],
  targetType: "purchase" | "product",
  targetId: string,
): DataQualityException[] =>
  exceptions.map((exception) => ({ ...exception, targetType, targetId }));

const uniqueTargetExceptions = (
  exceptions: DataQualityException[],
): DataQualityException[] =>
  uniqBy(
    exceptions,
    (exception) =>
      `${exception.targetType}\u0000${exception.targetId}\u0000${exception.check}`,
  );

export const loadProductDataQualities = async (
  db: Database,
  ids: ProductId[],
): Promise<Map<ProductId, DataQuality>> => {
  const uniqueIds = uniq(ids);
  if (uniqueIds.length === 0) return new Map();
  const [products, linkedExpenses, amazonExpenses, productExternalIds] =
    await Promise.all([
      getDb(db)
        .select({
          id: product.id,
          shortcode: product.shortcode,
          manufacturer: product.manufacturer,
          category: product.category,
          model: product.model,
          dataExceptions: product.dataExceptions,
        })
        .from(product)
        .where(and(inArray(product.id, uniqueIds), notDeleted(product))),
      getDb(db)
        .selectDistinct({ productId: expense.productId })
        .from(expense)
        .where(
          and(
            inArray(expense.productId, uniqueIds),
            isNotNull(expense.productId),
            notDeleted(expense),
          ),
        ),
      getDb(db)
        .selectDistinct({ productId: expense.productId })
        .from(expense)
        .innerJoin(
          purchase,
          and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
        )
        .innerJoin(
          vendor,
          and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
        )
        .where(
          and(
            inArray(expense.productId, uniqueIds),
            isNotNull(expense.productId),
            notDeleted(expense),
            sql`lower(${vendor.name}) LIKE 'amazon%'`,
          ),
        ),
      getDb(db)
        .select({
          productId: productExternalId.productId,
          source: productExternalId.source,
          kind: productExternalId.kind,
          externalId: productExternalId.externalId,
        })
        .from(productExternalId)
        .innerJoin(
          product,
          and(eq(product.id, productExternalId.productId), notDeleted(product)),
        )
        .where(
          and(
            inArray(productExternalId.productId, uniqueIds),
            notDeleted(productExternalId),
          ),
        ),
    ]);

  const externalIdPairs = uniqBy(productExternalIds, externalIdCollisionKey);
  const activeExternalIdOwners =
    externalIdPairs.length === 0
      ? []
      : await getDb(db)
          .select({
            productId: productExternalId.productId,
            source: productExternalId.source,
            kind: productExternalId.kind,
            externalId: productExternalId.externalId,
          })
          .from(productExternalId)
          .innerJoin(
            product,
            and(
              eq(product.id, productExternalId.productId),
              notDeleted(product),
            ),
          )
          .where(
            and(
              notDeleted(productExternalId),
              or(
                ...externalIdPairs.map((row) =>
                  and(
                    eq(
                      sql<string>`lower(${productExternalId.source})`,
                      row.source.trim().toLowerCase(),
                    ),
                    eq(productExternalId.kind, row.kind),
                    eq(productExternalId.externalId, row.externalId),
                  ),
                ),
              ),
            ),
          );

  const expenseLinked = new Set(
    linkedExpenses.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  const amazonLinked = new Set(
    amazonExpenses.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  const externalIdsByProduct = groupBy(
    productExternalIds,
    (row) => row.productId,
  );
  const externalIdOwners = groupBy(
    activeExternalIdOwners,
    externalIdCollisionKey,
  );
  const result = new Map<ProductId, DataQuality>();

  for (const row of products) {
    const gaps: DataQualityGap[] = [];
    const targetId = unsafeProductShortcode(row.shortcode);
    const add = (check: ProductDataCheck, message: string) => {
      if (!hasStoredException(row.dataExceptions, check)) {
        gaps.push({ check, targetType: "product", targetId, message });
      }
    };
    if (expenseLinked.has(row.id)) {
      if (
        row.manufacturer.trim() === "" ||
        row.manufacturer.trim().toLowerCase() ===
          UNSPECIFIED_MANUFACTURER.toLowerCase()
      ) {
        add("product_manufacturer", "Manufacturer is not recorded.");
      }
      if (row.category === null) {
        add("product_category", "Product category is not recorded.");
      }
      if (row.model === null || row.model.trim() === "") {
        add("product_model", "Manufacturer model is not recorded.");
      }
      const externalIds = externalIdsByProduct[row.id] ?? [];
      if (
        amazonLinked.has(row.id) &&
        !externalIds.some(
          (externalId) => externalId.source.toLowerCase() === AMAZON_SOURCE,
        )
      ) {
        add("amazon_asin", "Amazon-linked product has no Amazon ASIN.");
      }
      if (
        externalIds.some(
          (externalId) =>
            (externalIdOwners[externalIdCollisionKey(externalId)]?.length ??
              0) > 1,
        )
      ) {
        add(
          "duplicate_external_id",
          "An exact external identifier is shared with another live product.",
        );
      }
    }
    result.set(
      row.id,
      complete(
        gaps,
        targetExceptions(
          row.dataExceptions,
          "product",
          unsafeProductShortcode(row.shortcode),
        ),
      ),
    );
  }
  return result;
};

export const loadPurchaseDataQualities = async (
  db: Database,
  ids: PurchaseId[],
): Promise<Map<PurchaseId, DataQuality>> => {
  const uniqueIds = uniq(ids);
  if (uniqueIds.length === 0) return new Map();
  const [purchases, documents, expenses, qualifyingTransactions] =
    await Promise.all([
      getDb(db)
        .select({
          id: purchase.id,
          shortcode: purchase.shortcode,
          date: purchase.date,
          orderId: purchase.orderId,
          statedTotal: purchase.statedTotal,
          dataExceptions: purchase.dataExceptions,
        })
        .from(purchase)
        .where(and(inArray(purchase.id, uniqueIds), notDeleted(purchase))),
      getDb(db)
        .select({
          purchaseId: purchaseImage.purchaseId,
          documentKind: purchaseImage.documentKind,
        })
        .from(purchaseImage)
        .innerJoin(
          image,
          and(eq(image.id, purchaseImage.imageId), notDeleted(image)),
        )
        .where(
          and(
            inArray(purchaseImage.purchaseId, uniqueIds),
            notDeleted(purchaseImage),
          ),
        ),
      getDb(db)
        .select({
          purchaseId: expense.purchaseId,
          cost: expense.cost,
          productId: expense.productId,
        })
        .from(expense)
        .where(
          and(inArray(expense.purchaseId, uniqueIds), notDeleted(expense)),
        ),
      getDb(db)
        .select({
          purchaseId: financialTransaction.purchaseId,
          hasSettlementReference: sql<boolean>`bool_or(
            ${financialTransaction.status} = 'posted'
            AND jsonb_array_length(${financialTransaction.sourceRefs}) > 0
          )`,
          postedRefundTotal: sql<number>`COALESCE(sum(${financialTransaction.amount}) FILTER (
            WHERE ${financialTransaction.status} = 'posted'
              AND ${financialTransaction.kind} = 'refund'
          ), 0)::double precision`,
        })
        .from(financialTransaction)
        .where(
          and(
            inArray(financialTransaction.purchaseId, uniqueIds),
            notDeleted(financialTransaction),
          ),
        )
        .groupBy(financialTransaction.purchaseId),
    ]);
  const expensesByPurchase = groupBy(expenses, (row) => row.purchaseId ?? "");
  const documentsByPurchase = groupBy(documents, (row) => row.purchaseId);
  const settlementCovered = new Set(
    qualifyingTransactions.flatMap((row) =>
      row.purchaseId && row.hasSettlementReference ? [row.purchaseId] : [],
    ),
  );
  const postedRefundByPurchase = new Map(
    qualifyingTransactions.flatMap((row) =>
      row.purchaseId
        ? [[row.purchaseId, Number(row.postedRefundTotal)] as const]
        : [],
    ),
  );
  const productIds = uniq(
    expenses.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  const productQualities = await loadProductDataQualities(db, productIds);
  const result = new Map<PurchaseId, DataQuality>();

  for (const row of purchases) {
    const purchaseExpenses = expensesByPurchase[row.id] ?? [];
    const gaps: DataQualityGap[] = [];
    const targetId = unsafePurchaseShortcode(row.shortcode);
    const add = (check: PurchaseDataCheck, message: string) => {
      if (!hasStoredException(row.dataExceptions, check)) {
        gaps.push({ check, targetType: "purchase", targetId, message });
      }
    };
    if (row.date === null)
      add("purchase_date", "Purchase date is not recorded.");
    if (row.orderId === null)
      add("order_id", "Vendor order or receipt ID is not recorded.");
    if (row.statedTotal === null)
      add("stated_total", "Literal vendor-stated total is not recorded.");
    if (
      !(documentsByPurchase[row.id] ?? []).some((document) =>
        primaryPurchaseDocumentKinds.some(
          (kind) => kind === document.documentKind,
        ),
      )
    ) {
      add(
        "primary_document",
        "No primary order confirmation, sales order, invoice, or receipt is attached.",
      );
    }
    if (purchaseExpenses.length === 0) {
      add("empty_expenses", "Purchase has no live Expenses.");
    }
    const unpriced = purchaseExpenses.filter(
      (item) => item.cost === null,
    ).length;
    if (unpriced > 0) {
      add(
        "unpriced_expense",
        `${unpriced} linked Expense${unpriced === 1 ? " is" : "s are"} unpriced.`,
      );
    }
    const expenseTotal = purchaseExpenses.reduce(
      (sum, item) => sum + (item.cost ?? 0),
      0,
    );
    if (
      reconcilePurchase({
        statedTotal: row.statedTotal,
        expenseTotal,
        unpricedExpenseCount: unpriced,
        postedRefundTotal: postedRefundByPurchase.get(row.id) ?? 0,
      }) === "mismatch"
    ) {
      add(
        "paperwork_mismatch",
        "Expense total differs from the literal vendor-stated total, and posted refunds do not fully explain it.",
      );
    }
    if (!settlementCovered.has(row.id)) {
      add(
        "settlement_reference",
        "No posted, non-void FinancialTransaction with a source reference is linked.",
      );
    }
    const seenProducts = new Set<ProductId>();
    const rolledProductExceptions: DataQualityException[] = [];
    for (const item of purchaseExpenses) {
      if (!item.productId || seenProducts.has(item.productId)) continue;
      seenProducts.add(item.productId);
      const productQuality = productQualities.get(item.productId);
      gaps.push(...(productQuality?.gaps ?? []));
      rolledProductExceptions.push(...(productQuality?.exceptions ?? []));
    }
    result.set(
      row.id,
      complete(
        gaps,
        uniqueTargetExceptions([
          ...targetExceptions(
            row.dataExceptions,
            "purchase",
            unsafePurchaseShortcode(row.shortcode),
          ),
          ...rolledProductExceptions,
        ]),
      ),
    );
  }
  return result;
};

const assertCheckApplies = (
  entity: "purchase" | "product",
  check: DataCheck,
) => {
  const valid =
    entity === "purchase"
      ? purchaseDataCheck.safeParse(check).success
      : productDataCheck.safeParse(check).success;
  if (!valid) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${check} does not apply to ${entity} data quality.`,
    );
  }
};

const mutateException = async (
  db: Database,
  input: SetDataExceptionInput | ClearDataExceptionInput,
  actor: ActorContext,
): Promise<DataQuality> => {
  const parsed = parseShortcode(input.entityId);
  if (parsed?.type !== "purchase" && parsed?.type !== "product") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.entityId} is not a Purchase or Product.`,
    );
  }
  assertCheckApplies(parsed.type, input.check);
  const resolved = await resolveLiveShortcode(db, input.entityId, parsed.type);
  if (!resolved) {
    throw createAppError(
      parsed.type === "purchase" ? "PURCHASE_NOT_FOUND" : "PRODUCT_NOT_FOUND",
      `${parsed.type} not found: ${input.entityId}`,
    );
  }

  await withTransaction(db, async (tx) => {
    const current =
      parsed.type === "purchase"
        ? ((
            await tx
              .select({ dataExceptions: purchase.dataExceptions })
              .from(purchase)
              .where(
                and(
                  eq(purchase.id, unsafePurchaseId(resolved)),
                  notDeleted(purchase),
                ),
              )
              .limit(1)
          )[0]?.dataExceptions ?? [])
        : ((
            await tx
              .select({ dataExceptions: product.dataExceptions })
              .from(product)
              .where(
                and(
                  eq(product.id, unsafeProductId(resolved)),
                  notDeleted(product),
                ),
              )
              .limit(1)
          )[0]?.dataExceptions ?? []);
    const retained = current.filter((item) => item.check !== input.check);
    const next =
      "reason" in input
        ? [
            ...retained,
            {
              check: input.check,
              reason: input.reason,
              note: input.note.trim(),
            },
          ]
        : retained;
    if (parsed.type === "purchase") {
      await updateLiveAndReturn(
        tx,
        purchase,
        { dataExceptions: next },
        unsafePurchaseId(resolved),
      );
    } else {
      await updateLiveAndReturn(
        tx,
        product,
        { dataExceptions: next },
        unsafeProductId(resolved),
      );
    }
    const changes = computeChanges(
      { dataExceptions: current },
      { dataExceptions: next },
      ["dataExceptions"],
    );
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: parsed.type,
        entityId:
          parsed.type === "purchase"
            ? unsafePurchaseId(resolved)
            : unsafeProductId(resolved),
        action: "update",
        changes,
      });
    }
  });

  return parsed.type === "purchase"
    ? (await loadPurchaseDataQualities(db, [unsafePurchaseId(resolved)])).get(
        unsafePurchaseId(resolved),
      )!
    : (await loadProductDataQualities(db, [unsafeProductId(resolved)])).get(
        unsafeProductId(resolved),
      )!;
};

export const setDataException = (
  db: Database,
  input: SetDataExceptionInput,
  actor: ActorContext,
) => mutateException(db, input, actor);

export const clearDataException = (
  db: Database,
  input: ClearDataExceptionInput,
  actor: ActorContext,
) => mutateException(db, input, actor);

export const findProductExternalIdCollisions = async (
  db: Database,
  input?: {
    source?: string | string[];
    identifiers?: Array<{ source: string; kind: string; externalId: string }>;
  },
) => {
  const selected = input?.source
    ? [input.source].flat().map((source) => source.trim().toLowerCase())
    : undefined;
  const identifiers = input?.identifiers?.map((identifier) => ({
    ...identifier,
    source: identifier.source.trim().toLowerCase(),
  }));
  const rows = await getDb(db)
    .select({
      source: productExternalId.source,
      kind: productExternalId.kind,
      externalId: productExternalId.externalId,
      productId: product.id,
      productShortcode: product.shortcode,
      productName: product.name,
    })
    .from(productExternalId)
    .innerJoin(
      product,
      and(eq(product.id, productExternalId.productId), notDeleted(product)),
    )
    .where(
      and(
        notDeleted(productExternalId),
        selected && selected.length > 0
          ? inArray(sql<string>`lower(${productExternalId.source})`, selected)
          : identifiers && identifiers.length > 0
            ? or(
                ...identifiers.map((identifier) =>
                  and(
                    eq(
                      sql<string>`lower(${productExternalId.source})`,
                      identifier.source,
                    ),
                    eq(productExternalId.kind, identifier.kind),
                    eq(productExternalId.externalId, identifier.externalId),
                  ),
                ),
              )
            : undefined,
      ),
    );
  const grouped = groupBy(rows, externalIdCollisionKey);
  const items = Object.entries(grouped).flatMap(([, matches]) =>
    matches.length > 1
      ? [
          {
            source: matches[0]!.source.trim().toLowerCase(),
            kind: matches[0]!
              .kind as import("@cubby/schemas/external-id").ExternalIdKind,
            externalId: matches[0]!.externalId,
            products: matches.map((row) => ({
              id: unsafeProductShortcode(row.productShortcode),
              name: row.productName,
            })),
          },
        ]
      : [],
  );
  return {
    items,
    results: (identifiers ?? []).map((identifier) => {
      const matches = grouped[externalIdCollisionKey(identifier)] ?? [];
      return {
        ...identifier,
        status:
          matches.length === 0
            ? ("missing" as const)
            : matches.length === 1
              ? ("unique" as const)
              : ("collision" as const),
        products: matches.map((row) => ({
          id: unsafeProductShortcode(row.productShortcode),
          name: row.productName,
        })),
      };
    }),
  };
};

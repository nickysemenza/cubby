import {
  unsafeExpenseShortcode,
  unsafeProductId,
  unsafeProductShortcode,
  unsafeProjectShortcode,
  unsafePurchaseShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import type {
  ProductMovementGroupOut,
  ProductMovementLineOut,
  ProductMovementProductOut,
  ProductMovementTimelineInput,
  ProductMovementTimelineOut,
} from "@cubby/schemas/product";
import { and, eq, inArray } from "drizzle-orm";
import { groupBy, sumBy } from "es-toolkit";
import { householdLocalDate } from "~/lib/household-date";
import {
  buildConfidentOwnershipIntervals,
  classifyProductMovement,
} from "~/lib/product-movement";
import type { Database } from "~/server/db";
import {
  expense,
  project,
  projectToolUsage,
  purchase,
  purchaseProduct,
  vendor,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { productList } from "./crud";

const ALL_PRODUCTS = { pageIndex: 0, pageSize: 100_000 } as const;

const emptyTimeline = (): ProductMovementTimelineOut => ({
  products: [],
  groups: [],
  summary: {
    matchingProducts: 0,
    productsWithMovements: 0,
    movementCount: 0,
    spent: 0,
    recovered: 0,
    netCost: 0,
    unknownAmountCount: 0,
  },
  extent: null,
  omitted: { productsWithoutMovements: 0, plannedMovements: 0 },
});

export async function getProductMovementTimeline(
  db: Database,
  input: ProductMovementTimelineInput,
): Promise<ProductMovementTimelineOut> {
  const cohort = await productList(
    db,
    input.filters,
    [{ orderBy: "name", direction: "asc" }],
    ALL_PRODUCTS,
  );
  if (cohort.data.length === 0) return emptyTimeline();

  const resolved = await resolveLiveShortcodes(
    db,
    cohort.data.map((item) => item.id),
    "product",
  );
  const idByCode = new Map(
    [...resolved].map(([code, id]) => [code, unsafeProductId(id)]),
  );
  const codeById = new Map(
    [...idByCode].map(([code, id]) => [id, unsafeProductShortcode(code)]),
  );
  const productIds = [...idByCode.values()];
  if (productIds.length === 0) return emptyTimeline();

  const rows = await getDb(db)
    .select({
      expenseCode: expense.shortcode,
      expenseName: expense.name,
      expenseDate: expense.date,
      cost: expense.cost,
      quantity: expense.productQuantity,
      future: expense.future,
      productId: expense.productId,
      purchaseId: purchase.id,
      purchaseCode: purchase.shortcode,
      purchaseDate: purchase.date,
      purchaseDisplayLabel: purchase.displayLabel,
      orderId: purchase.orderId,
      vendorCode: vendor.shortcode,
      vendorName: vendor.name,
      projectCode: project.shortcode,
      projectName: project.name,
    })
    .from(expense)
    .leftJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .leftJoin(vendor, and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)))
    .leftJoin(
      project,
      and(eq(project.id, expense.projectId), notDeleted(project)),
    )
    .where(and(notDeleted(expense), inArray(expense.productId, productIds)));

  const actualRows = rows.filter(
    (row) => !row.future && row.productId !== null,
  );
  const itemizedPairs = new Set(
    actualRows.flatMap((row) =>
      row.purchaseId && row.productId
        ? [`${row.purchaseId}:${row.productId}`]
        : [],
    ),
  );
  const provenanceRows = await getDb(db)
    .select({
      productId: purchaseProduct.productId,
      purchaseId: purchase.id,
      purchaseCode: purchase.shortcode,
      purchaseDate: purchase.date,
      purchaseDisplayLabel: purchase.displayLabel,
      orderId: purchase.orderId,
      vendorCode: vendor.shortcode,
      vendorName: vendor.name,
    })
    .from(purchaseProduct)
    .innerJoin(
      purchase,
      and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
    )
    .leftJoin(vendor, and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)))
    .where(
      and(
        notDeleted(purchaseProduct),
        inArray(purchaseProduct.productId, productIds),
      ),
    );
  const unitemizedRows = provenanceRows.filter(
    (row) => !itemizedPairs.has(`${row.purchaseId}:${row.productId}`),
  );

  const expenseMovementRows = actualRows.flatMap((row) => {
    const productId = row.productId ? codeById.get(row.productId) : undefined;
    if (!productId) return [];
    const classification = classifyProductMovement(row.cost, row.quantity);
    const date = row.purchaseDate ?? row.expenseDate;
    if (input.movementFrom && date < input.movementFrom) return [];
    if (input.movementTo && date > input.movementTo) return [];
    const movement: ProductMovementLineOut = {
      expenseId: unsafeExpenseShortcode(row.expenseCode),
      productId,
      name: row.expenseName,
      kind: classification.kind,
      cost: row.cost,
      quantity: row.quantity,
      signedQuantity: classification.signedQuantity,
      expenseDate: row.expenseDate,
      chargedTo:
        row.projectCode && row.projectName
          ? {
              id: unsafeProjectShortcode(row.projectCode),
              name: row.projectName,
            }
          : null,
      provenanceOnly: false,
    };
    return [
      {
        key: row.purchaseId
          ? `purchase:${row.purchaseCode}`
          : `expense:${row.expenseCode}`,
        date,
        purchase:
          row.purchaseId && row.purchaseCode
            ? {
                id: unsafePurchaseShortcode(row.purchaseCode),
                displayLabel: row.purchaseDisplayLabel,
                orderId: row.orderId,
                date: row.purchaseDate,
                vendor:
                  row.vendorCode && row.vendorName
                    ? {
                        id: unsafeVendorShortcode(row.vendorCode),
                        name: row.vendorName,
                      }
                    : null,
              }
            : null,
        movement,
      },
    ];
  });
  const provenanceMovementRows = unitemizedRows.flatMap((row) => {
    const productId = codeById.get(row.productId);
    if (!productId) return [];
    if (input.movementFrom && row.purchaseDate < input.movementFrom) return [];
    if (input.movementTo && row.purchaseDate > input.movementTo) return [];
    const movement: ProductMovementLineOut = {
      expenseId: null,
      productId,
      name:
        row.purchaseDisplayLabel ??
        row.orderId ??
        "Unitemized purchase product",
      kind: "acquired",
      cost: null,
      quantity: null,
      signedQuantity: null,
      expenseDate: row.purchaseDate,
      chargedTo: null,
      provenanceOnly: true,
    };
    return [
      {
        key: `purchase:${row.purchaseCode}`,
        date: row.purchaseDate,
        purchase: {
          id: unsafePurchaseShortcode(row.purchaseCode),
          displayLabel: row.purchaseDisplayLabel,
          orderId: row.orderId,
          date: row.purchaseDate,
          vendor:
            row.vendorCode && row.vendorName
              ? {
                  id: unsafeVendorShortcode(row.vendorCode),
                  name: row.vendorName,
                }
              : null,
        },
        movement,
      },
    ];
  });
  const movementRows = [...expenseMovementRows, ...provenanceMovementRows];

  const grouped = groupBy(movementRows, (row) => row.key);
  const groups: ProductMovementGroupOut[] = Object.values(grouped).map(
    (members) => ({
      key: members[0]!.key,
      date: members[0]!.date,
      purchase: members[0]!.purchase,
      movements: members
        .map((member) => member.movement)
        .sort((left, right) => left.name.localeCompare(right.name)),
    }),
  );
  groups.sort((left, right) => {
    const direction = left.date.localeCompare(right.date);
    return input.order === "asc" ? direction : -direction;
  });

  const productCodesWithMovements = new Set(
    movementRows.map((row) => row.movement.productId),
  );
  const productIdsWithMovements = [...productCodesWithMovements].flatMap(
    (code) => {
      const productId = idByCode.get(code);
      return productId ? [productId] : [];
    },
  );
  const markersByProduct = groupBy(actualRows, (row) => row.productId!);
  const provenanceMarkersByProduct = groupBy(
    unitemizedRows,
    (row) => row.productId,
  );
  const usageRows =
    productIdsWithMovements.length === 0
      ? []
      : await getDb(db)
          .select({
            productId: projectToolUsage.productId,
            projectCode: project.shortcode,
            projectName: project.name,
          })
          .from(projectToolUsage)
          .innerJoin(
            project,
            and(
              eq(project.id, projectToolUsage.projectId),
              notDeleted(project),
            ),
          )
          .where(
            and(
              notDeleted(projectToolUsage),
              inArray(projectToolUsage.productId, productIdsWithMovements),
            ),
          );
  const usagesByProduct = groupBy(usageRows, (row) => row.productId);
  const today = householdLocalDate();
  const products: ProductMovementProductOut[] = cohort.data.flatMap((item) => {
    if (!productCodesWithMovements.has(item.id)) return [];
    const privateId = idByCode.get(item.id);
    if (!privateId) return [];
    const markers = [
      ...(markersByProduct[privateId] ?? []).map((row) => ({
        date: row.purchaseDate ?? row.expenseDate,
        signedQuantity: classifyProductMovement(row.cost, row.quantity)
          .signedQuantity,
      })),
      ...(provenanceMarkersByProduct[privateId] ?? []).map((row) => ({
        date: row.purchaseDate,
        signedQuantity: null,
      })),
    ];
    const ownership = buildConfidentOwnershipIntervals(markers, today);
    return [
      {
        id: item.id,
        name: item.name,
        manufacturer: item.manufacturer,
        category: item.category,
        coverImageUrl: item.images[0]?.url ?? null,
        usedOnProjects: (usagesByProduct[privateId] ?? [])
          .map((row) => ({
            id: unsafeProjectShortcode(row.projectCode),
            name: row.projectName,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        ownershipIntervals: ownership.intervals,
        confidenceLostAt: ownership.confidenceLostAt,
      },
    ];
  });

  const movements = groups.flatMap((group) => group.movements);
  const spent = sumBy(movements, (movement) =>
    movement.cost !== null && movement.cost > 0 ? movement.cost : 0,
  );
  const recovered = sumBy(movements, (movement) =>
    movement.cost !== null && movement.cost < 0 ? -movement.cost : 0,
  );
  const productsWithMovements = productCodesWithMovements.size;
  const dates = groups.map((group) => group.date).sort();

  return {
    products,
    groups,
    summary: {
      matchingProducts: cohort.count,
      productsWithMovements,
      movementCount: movements.length,
      spent,
      recovered,
      netCost: spent - recovered,
      unknownAmountCount: movements.filter((movement) => movement.cost === null)
        .length,
    },
    extent:
      dates.length > 0
        ? { from: dates[0]!, to: dates[dates.length - 1]! }
        : null,
    omitted: {
      productsWithoutMovements: cohort.count - productsWithMovements,
      plannedMovements: rows.filter((row) => row.future).length,
    },
  };
}

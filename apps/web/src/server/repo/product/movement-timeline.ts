import type {
  EntityTimelineOut,
  EntityTimelinePagination,
} from "@cubby/schemas/entity-timeline";
import {
  type ExpenseShortcode,
  parseEntityId,
  parseShortcodeFor,
  type ProductShortcode,
  type ProjectShortcode,
  type PurchaseShortcode,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import type {
  ProductCategory,
  ProductFilters,
  ProductMovementKind,
} from "@cubby/schemas/product";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { groupBy, sumBy } from "es-toolkit";

import { householdLocalDate } from "~/lib/household-date";
import {
  buildConfidentOwnershipIntervals,
  classifyProductMovement,
  type ProductOwnershipInterval,
} from "~/lib/product-movement";
import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import {
  expense,
  product,
  project,
  projectToolUsage,
  purchase,
  purchaseProduct,
  vendor,
} from "~/server/db/schema";
import type { EntityTimelineImplementation } from "~/server/entity-timeline/contracts";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { effectiveExpenseProjectSql } from "~/server/repo/expense-inheritance";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";

import { buildProductWhere, getProductsByShortcodes } from "./crud";

export interface ProductMovementTimelineInput {
  filters: ProductFilters;
  /** Narrows the cohort to these products; the filters are ignored then. */
  ids?: readonly string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  order: "asc" | "desc";
  pagination: EntityTimelinePagination;
}

type MovementProject = { id: ProjectShortcode; name: string };
export type ProductMovementLine = {
  expenseId: ExpenseShortcode | null;
  productId: ProductShortcode;
  name: string;
  kind: ProductMovementKind;
  /** Positive when money left the household, negative when it came back. */
  cost: number | null;
  quantity: number | null;
  signedQuantity: number | null;
  expenseDate: string | null;
  chargedTo: MovementProject | null;
  provenanceOnly: boolean;
};
export type ProductMovementPurchase = {
  id: PurchaseShortcode;
  displayLabel: string | null;
  orderId: string | null;
  date: string | null;
  vendor: { id: VendorShortcode; name: string } | null;
};
export type ProductMovementGroup = {
  key: string;
  date: string | null;
  purchase: ProductMovementPurchase | null;
  movements: ProductMovementLine[];
};
export type ProductMovementProduct = {
  id: ProductShortcode;
  name: string;
  manufacturer: string;
  category: ProductCategory | null;
  coverImageUrl: string | null;
  usedOnProjects: MovementProject[];
  ownershipIntervals: ProductOwnershipInterval[];
  confidenceLostAt: string | null;
};
export interface ProductMovementTimeline {
  products: ProductMovementProduct[];
  groups: ProductMovementGroup[];
  summary: {
    matchingProducts: number;
    productsWithMovements: number;
    movementCount: number;
    spent: number;
    recovered: number;
    netCost: number;
    unknownAmountCount: number;
  };
  extent: { from: string; to: string } | null;
  omitted: { productsWithoutMovements: number; plannedMovements: number };
  /** `totalCount` is every product with a movement in the window; the
   * groups, rows and movement totals cover only this page of them. */
  meta: EntityTimelinePagination & { totalCount: number };
}

type CohortProduct = {
  id: ProductShortcode;
  name: string;
  manufacturer: string;
  category: ProductCategory | null;
  coverImageUrl: string | null;
};

const emptyTimeline = (
  pagination: EntityTimelinePagination,
  matchingProducts: number,
  totalCount: number,
): ProductMovementTimeline => ({
  products: [],
  groups: [],
  summary: {
    matchingProducts,
    productsWithMovements: 0,
    movementCount: 0,
    spent: 0,
    recovered: 0,
    netCost: 0,
    unknownAmountCount: 0,
  },
  extent: null,
  omitted: {
    productsWithoutMovements: matchingProducts - totalCount,
    plannedMovements: 0,
  },
  meta: { ...pagination, totalCount },
});

/**
 * Each product's movement dates, as the timeline below dates them: an
 * expense on its purchase's date (undated when the expense is), and a
 * purchase line no expense itemizes on the purchase date. Planned (`future`)
 * expenses are not movements.
 */
const movementDates = (db: Database) =>
  unionAll(
    getDb(db)
      .select({
        productId: sql<string>`${expense.productId}`.as("productId"),
        date: sql<
          string | null
        >`case when ${expense.date} is null then null else coalesce(${purchase.date}, ${expense.date}) end`.as(
          "date",
        ),
      })
      .from(expense)
      .leftJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .where(
        and(
          notDeleted(expense),
          eq(expense.future, false),
          isNotNull(expense.productId),
        ),
      ),
    getDb(db)
      .select({
        productId: sql<string>`${purchaseProduct.productId}`.as("productId"),
        date: sql<string | null>`${purchase.date}`.as("date"),
      })
      .from(purchaseProduct)
      .innerJoin(
        purchase,
        and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
      )
      .where(
        and(
          notDeleted(purchaseProduct),
          notExists(
            getDb(db)
              .select({ one: sql`1` })
              .from(expense)
              .where(
                and(
                  eq(expense.purchaseId, purchase.id),
                  eq(expense.productId, purchaseProduct.productId),
                  eq(expense.future, false),
                  notDeleted(expense),
                ),
              ),
          ),
        ),
      ),
  ).as("movement_dates");

/**
 * One page of the products that moved inside the window, in the window's
 * order: newest-first pages by latest movement, oldest-first by first
 * movement (undated-only products last either way), then id so pages are
 * stable; plus how many products match the filters at all.
 */
async function loadCohort(
  db: Database,
  input: ProductMovementTimelineInput,
): Promise<{
  data: CohortProduct[];
  matchingProducts: number;
  totalCount: number;
}> {
  const scope: SQL | undefined = input.ids
    ? and(notDeleted(product), inArray(product.shortcode, [...input.ids]))
    : await buildProductWhere(db, input.filters);
  const moves = movementDates(db);
  const inWindow = and(
    input.from ? gte(moves.date, input.from) : undefined,
    input.to ? lte(moves.date, input.to) : undefined,
  );
  const movers = getDb(db)
    .select({
      productId: moves.productId,
      start: sql<string | null>`min(${moves.date})`.as("start"),
      latest: sql<string | null>`max(${moves.date})`.as("latest"),
    })
    .from(moves)
    .where(inWindow)
    .groupBy(moves.productId)
    .as("movers");
  const { pageIndex, pageSize } = input.pagination;
  const [page, [moverCount], [matching]] = await Promise.all([
    getDb(db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .innerJoin(movers, eq(movers.productId, product.id))
      .where(scope)
      .orderBy(
        input.order === "desc"
          ? sql`${movers.latest} desc nulls last`
          : sql`${movers.start} asc nulls last`,
        asc(product.id),
      )
      .limit(pageSize)
      .offset(pageIndex * pageSize),
    getDb(db)
      .select({ value: count() })
      .from(product)
      .innerJoin(movers, eq(movers.productId, product.id))
      .where(scope),
    getDb(db).select({ value: count() }).from(product).where(scope),
  ]);
  const codes = page.map((row) => parseShortcodeFor("product", row.shortcode));
  const byCode = new Map(
    (await getProductsByShortcodes(db, codes)).map((item) => [item.id, item]),
  );
  return {
    data: codes.flatMap((code) => {
      const item = byCode.get(code);
      return item
        ? [
            {
              id: item.id,
              name: item.name,
              manufacturer: item.manufacturer,
              category: item.category,
              coverImageUrl: item.coverImageUrl,
            },
          ]
        : [];
    }),
    matchingProducts: matching?.value ?? 0,
    totalCount: moverCount?.value ?? 0,
  };
}

export async function getProductMovementTimeline(
  db: Database,
  input: ProductMovementTimelineInput,
): Promise<ProductMovementTimeline> {
  const cohort = await loadCohort(db, input);
  const empty = () =>
    emptyTimeline(input.pagination, cohort.matchingProducts, cohort.totalCount);
  if (cohort.data.length === 0) return empty();

  const resolved = await resolveLiveShortcodes(
    db,
    cohort.data.map((item) => item.id),
    "product",
  );
  const idByCode = new Map(
    [...resolved].map(([code, id]) => [code, parseEntityId("product", id)]),
  );
  const codeById = new Map(
    [...idByCode].map(([code, id]) => [id, parseShortcodeFor("product", code)]),
  );
  const productIds = [...idByCode.values()];
  if (productIds.length === 0) return empty();

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
      and(eq(project.id, effectiveExpenseProjectSql()), notDeleted(project)),
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
    const date =
      row.expenseDate === null ? null : (row.purchaseDate ?? row.expenseDate);
    if (input.from && (date === null || date < input.from)) return [];
    if (input.to && (date === null || date > input.to)) return [];
    const movement: ProductMovementLine = {
      expenseId: parseShortcodeFor("expense", row.expenseCode),
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
              id: parseShortcodeFor("project", row.projectCode),
              name: row.projectName,
            }
          : null,
      provenanceOnly: false,
    };
    return [
      {
        key:
          date === null
            ? `undated:${row.purchaseCode ?? row.expenseCode}`
            : row.purchaseId
              ? `purchase:${row.purchaseCode}`
              : `expense:${row.expenseCode}`,
        date,
        purchase:
          row.purchaseId && row.purchaseCode
            ? {
                id: parseShortcodeFor("purchase", row.purchaseCode),
                displayLabel: row.purchaseDisplayLabel,
                orderId: row.orderId,
                date: row.purchaseDate,
                vendor:
                  row.vendorCode && row.vendorName
                    ? {
                        id: parseShortcodeFor("vendor", row.vendorCode),
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
    if (input.from && row.purchaseDate < input.from) return [];
    if (input.to && row.purchaseDate > input.to) return [];
    const movement: ProductMovementLine = {
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
          id: parseShortcodeFor("purchase", row.purchaseCode),
          displayLabel: row.purchaseDisplayLabel,
          orderId: row.orderId,
          date: row.purchaseDate,
          vendor:
            row.vendorCode && row.vendorName
              ? {
                  id: parseShortcodeFor("vendor", row.vendorCode),
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
  const groups: ProductMovementGroup[] = Object.values(grouped).map(
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
    if (left.date === null)
      return right.date === null ? left.key.localeCompare(right.key) : 1;
    if (right.date === null) return -1;
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
  const products: ProductMovementProduct[] = cohort.data.flatMap((item) => {
    if (!productCodesWithMovements.has(item.id)) return [];
    const privateId = idByCode.get(item.id);
    if (!privateId) return [];
    const markers = [
      ...(markersByProduct[privateId] ?? []).map((row) => ({
        date:
          row.expenseDate === null
            ? null
            : (row.purchaseDate ?? row.expenseDate),
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
        coverImageUrl: item.coverImageUrl,
        usedOnProjects: (usagesByProduct[privateId] ?? [])
          .map((row) => ({
            id: parseShortcodeFor("project", row.projectCode),
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
  const dates = groups
    .flatMap((group) => (group.date === null ? [] : [group.date]))
    .sort();

  return {
    products,
    groups,
    summary: {
      matchingProducts: cohort.matchingProducts,
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
      productsWithoutMovements: cohort.matchingProducts - cohort.totalCount,
      plannedMovements: rows.filter((row) => row.future).length,
    },
    meta: { ...input.pagination, totalCount: cohort.totalCount },
  };
}

const KIND_LABEL = {
  acquired: "Acquired",
  exited: "Exited",
  discarded: "Discarded",
  adjusted: "Price adjusted",
  unknown: "Unknown",
} as const satisfies Record<ProductMovementKind, string>;

const purchaseLabel = (purchase: ProductMovementPurchase) =>
  [purchase.vendor?.name, purchase.displayLabel ?? purchase.orderId]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ") || "Purchase";

const unitsLabel = (movement: ProductMovementLine) =>
  movement.provenanceOnly
    ? "Amount and quantity not itemized"
    : movement.quantity === null
      ? "Quantity unknown"
      : movement.quantity === 0
        ? "No unit moved"
        : `${Math.abs(movement.quantity)} unit${Math.abs(movement.quantity) === 1 ? "" : "s"}`;

/**
 * The movement timeline in the generic `EntityTimelineOut` shape: purchase
 * groups become dated groups, movements become events whose `amount` keeps
 * the ledger sign (positive spent, negative recovered), proven ownership
 * spans become confident intervals and the span after `confidenceLostAt`
 * an open unconfident one.
 */
export function toEntityTimeline(
  timeline: ProductMovementTimeline,
): EntityTimelineOut {
  const groups = timeline.groups.map((group) => ({
    key: group.key,
    date: group.date,
    label: group.purchase ? purchaseLabel(group.purchase) : null,
    link: group.purchase ? { entity: "purchase", id: group.purchase.id } : null,
    events: group.movements.map((movement) => ({
      id: movement.expenseId
        ? `expense:${movement.expenseId}`
        : `${group.key}:${movement.productId}:provenance`,
      kind: movement.kind,
      label: movement.name,
      amount: movement.cost,
      link: movement.expenseId
        ? { entity: "expense", id: movement.expenseId }
        : { entity: "product", id: movement.productId },
      detail: [
        KIND_LABEL[movement.kind],
        unitsLabel(movement),
        movement.chargedTo ? `Charged to ${movement.chargedTo.name}` : null,
        group.date === null && group.purchase
          ? `Purchase date ${group.purchase.date}`
          : null,
        movement.expenseDate !== null && movement.expenseDate !== group.date
          ? `Ledger date ${movement.expenseDate}`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    })),
  }));
  const markersByProduct = new Map<
    string,
    { date: string; kind: string; link: { entity: string; id: string } }[]
  >();
  for (const group of timeline.groups) {
    if (group.date === null) continue;
    for (const movement of group.movements) {
      const marker = {
        date: group.date,
        kind: movement.kind,
        link: movement.expenseId
          ? { entity: "expense", id: movement.expenseId }
          : { entity: "product", id: movement.productId },
      };
      const current = markersByProduct.get(movement.productId);
      if (current) current.push(marker);
      else markersByProduct.set(movement.productId, [marker]);
    }
  }
  const rows = timeline.products.map((product) => ({
    id: product.id,
    name: product.name,
    imageUrl: product.coverImageUrl,
    intervals: [
      ...product.ownershipIntervals.map((interval) => ({
        start: interval.start,
        end: interval.end,
        confident: true,
      })),
      ...(product.confidenceLostAt
        ? [{ start: product.confidenceLostAt, end: null, confident: false }]
        : []),
    ],
    markers: markersByProduct.get(product.id) ?? [],
  }));
  const { summary, omitted, meta } = timeline;
  const notes: string[] = [];
  if (meta.totalCount > timeline.products.length)
    notes.push(
      `Movements and totals cover the ${timeline.products.length} product${timeline.products.length === 1 ? "" : "s"} on this page of ${meta.totalCount}.`,
    );
  if (omitted.productsWithoutMovements > 0)
    notes.push(
      `${omitted.productsWithoutMovements} matching product${omitted.productsWithoutMovements === 1 ? " has" : "s have"} no recorded movement in this window.`,
    );
  if (omitted.plannedMovements > 0)
    notes.push(
      `${omitted.plannedMovements} planned movement${omitted.plannedMovements === 1 ? " is" : "s are"} omitted.`,
    );
  const out: EntityTimelineOut = {
    groups,
    rows,
    stats: [
      {
        key: "products",
        label: "Products",
        value: String(summary.matchingProducts),
      },
      {
        key: "movements",
        label: "Movements",
        value: String(summary.movementCount),
      },
      { key: "spent", label: "Spent", value: formatCurrency(summary.spent) },
      {
        key: "recovered",
        label: "Recovered",
        value: formatCurrency(summary.recovered),
      },
      {
        key: "netCost",
        label: "Net cost",
        value: formatCurrency(summary.netCost),
      },
      {
        key: "unknown",
        label: "Unknown / unitemized",
        value: String(summary.unknownAmountCount),
      },
    ],
    notes,
    meta,
  };
  if (timeline.extent) out.extent = timeline.extent;
  return out;
}

/** `resources.product.timeline`, bound through `ports.timeline`. */
export const productTimeline: EntityTimelineImplementation<"product"> = async (
  context,
  input,
) =>
  toEntityTimeline(
    await getProductMovementTimeline(context.readDb, {
      filters: input.filters,
      ids: input.window.ids,
      from: input.window.from,
      to: input.window.to,
      order: input.window.order,
      pagination: input.pagination,
    }),
  );

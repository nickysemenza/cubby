import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { LocationId } from "@cubby/schemas/identifiers";
import { countLabel } from "@cubby/shared/pluralize";
import { and, desc, eq, sql } from "drizzle-orm";

import { locationChildGroupLabel } from "~/lib/location-child-label";
import { formatCurrency } from "~/lib/number-format";
import { formatPricingCountsSummary } from "~/lib/pricing-counts";
import type { Database } from "~/server/db";
import { placementCondition } from "~/server/db/computed/inventory-placement";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import { inventoryEntry, product } from "~/server/db/schema";
import {
  inventoryValuationSql,
  loadInventoryValuations,
} from "~/server/domains/inventory/repo/valuation";
import { getLocationById } from "~/server/domains/location/repo/crud";

const TOP_MANUFACTURERS = 6;

/**
 * Stock held directly at the location, valued per entry (the figure the
 * inventory reads show) and summed per brandName in SQL: only this
 * location's entries are valued and only the top rows come back. Unpriced
 * entries (null valuation) add nothing.
 */
async function directValueByManufacturer(db: Database, locationId: LocationId) {
  const stock = and(
    notDeleted(inventoryEntry),
    placementCondition("stock"),
    eq(inventoryEntry.locationId, locationId),
  );
  const entries = await getDb(db)
    .select({
      id: inventoryEntry.id,
      productId: inventoryEntry.productId,
      amountValue: inventoryEntry.amountValue,
      amountUnit: inventoryEntry.amountUnit,
    })
    .from(inventoryEntry)
    .where(stock);
  const valuation = inventoryValuationSql(
    await loadInventoryValuations(db, entries),
    inventoryEntry.id,
  );
  const brandName = sql<string>`coalesce(nullif(${productBrandNameSql(product.brandId)}, ''), 'Unknown')`;
  const total = sql<number>`sum(${valuation})`;
  return getDb(db)
    .select({ brandName, total })
    .from(inventoryEntry)
    .innerJoin(product, eq(product.id, inventoryEntry.productId))
    .where(and(stock, sql`${valuation} is not null`))
    .groupBy(brandName)
    .orderBy(desc(total), brandName)
    .limit(TOP_MANUFACTURERS);
}

/**
 * The rolled-up total (direct stock plus descendants, from the persisted
 * `location.valuation`) and the by-brandName breakdown of the stock held
 * directly here.
 */
export async function locationContentsValuationReport(
  db: Database,
  id: LocationId,
): Promise<ReportBlock[]> {
  const [location, breakdown] = await Promise.all([
    getLocationById(db, id),
    directValueByManufacturer(db, id),
  ]);
  const valuation = location.valuation;
  const totalItems = valuation?.totalItemCount ?? location.totalItemCount ?? 0;
  const children = location.children ?? [];
  const pricingNote = formatPricingCountsSummary(valuation?.total);

  return [
    {
      kind: "stats",
      figures: [
        {
          label: "Total value",
          value: valuation?.totalValuation ?? null,
          format: "money",
        },
      ],
    },
    {
      kind: "note",
      text: `${countLabel(totalItems, "item")}${children.length > 0 ? ` across ${children.length} ${locationChildGroupLabel(children.map((child) => child.type)).toLowerCase()}` : ""}`,
    },
    ...(pricingNote ? [{ kind: "note" as const, text: pricingNote }] : []),
    ...(breakdown.length > 0
      ? [
          {
            kind: "table" as const,
            title: "Direct items by brandName",
            columns: ["Manufacturer", "Value"],
            rows: breakdown.map((row) => ({
              id: row.brandName,
              cells: [row.brandName, formatCurrency(row.total)],
            })),
          },
        ]
      : []),
  ];
}

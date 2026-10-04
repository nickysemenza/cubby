import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { LocationId } from "@cubby/schemas/identifiers";
import { and, desc, eq, sql } from "drizzle-orm";

import { locationChildGroupLabel } from "~/lib/location-child-label";
import { countLabel } from "~/lib/pluralize";
import { formatPricingCountsSummary } from "~/lib/pricing-counts";
import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { inventoryEntry, product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { placementCondition } from "~/server/repo/inventory/placement";
import {
  inventoryValuationSql,
  loadInventoryValuations,
} from "~/server/repo/inventory/valuation";
import { getLocationById } from "~/server/repo/location/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

const TOP_MANUFACTURERS = 6;

/**
 * Stock held directly at the location, valued per entry (the figure the
 * inventory reads show) and summed per manufacturer in SQL: only this
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
  const manufacturer = sql<string>`coalesce(nullif(${product.manufacturer}, ''), 'Unknown')`;
  const total = sql<number>`sum(${valuation})`;
  return getDb(db)
    .select({ manufacturer, total })
    .from(inventoryEntry)
    .innerJoin(product, eq(product.id, inventoryEntry.productId))
    .where(and(stock, sql`${valuation} is not null`))
    .groupBy(manufacturer)
    .orderBy(desc(total), manufacturer)
    .limit(TOP_MANUFACTURERS);
}

/**
 * The rolled-up total (direct stock plus descendants, from the persisted
 * `location.valuation`) and the by-manufacturer breakdown of the stock held
 * directly here.
 */
export async function locationContentsValuationReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "location", code);
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
          value: valuation?.totalValuation ?? 0,
          format: "money",
        },
      ],
    },
    {
      kind: "note",
      text: `${countLabel(totalItems, "item")}${children.length > 0 ? ` across ${children.length} ${locationChildGroupLabel(children).toLowerCase()}` : ""}`,
    },
    ...(pricingNote ? [{ kind: "note" as const, text: pricingNote }] : []),
    ...(breakdown.length > 0
      ? [
          {
            kind: "table" as const,
            title: "Direct items by manufacturer",
            columns: ["Manufacturer", "Value"],
            rows: breakdown.map((row) => ({
              id: row.manufacturer,
              cells: [row.manufacturer, formatCurrency(row.total)],
            })),
          },
        ]
      : []),
  ];
}

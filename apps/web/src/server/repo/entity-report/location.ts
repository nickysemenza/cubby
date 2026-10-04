import type { ReportBlock } from "@cubby/schemas/entity-report";

import { countLabel } from "~/lib/pluralize";
import { formatPricingCountsSummary } from "~/lib/pricing-counts";
import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { getInventoryByLocationIds } from "~/server/repo/inventory/crud";
import { getLocationById } from "~/server/repo/location/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

const TOP_MANUFACTURERS = 6;

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
  const [location, stock] = await Promise.all([
    getLocationById(db, id),
    getInventoryByLocationIds(db, [id], { placement: "stock" }),
  ]);
  const valuation = location.valuation;
  const totalItems = valuation?.totalItemCount ?? location.totalItemCount ?? 0;
  const children = location.children ?? [];
  const counts = valuation?.total;
  const pricingNote = formatPricingCountsSummary(counts);

  const byManufacturer = new Map<string, number>();
  for (const entry of stock) {
    if (entry.valuation == null) continue;
    const key = entry.product.manufacturer || "Unknown";
    byManufacturer.set(key, (byManufacturer.get(key) ?? 0) + entry.valuation);
  }
  const breakdown = [...byManufacturer]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_MANUFACTURERS);

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
      text: `${countLabel(totalItems, "item")}${children.length > 0 ? ` across ${countLabel(children.length, "child location")}` : ""}`,
    },
    ...(pricingNote ? [{ kind: "note" as const, text: pricingNote }] : []),
    ...(breakdown.length > 0
      ? [
          {
            kind: "table" as const,
            title: "Direct items by manufacturer",
            columns: ["Manufacturer", "Value"],
            rows: breakdown.map(([label, value]) => ({
              cells: [label, formatCurrency(value)],
            })),
          },
        ]
      : []),
  ];
}

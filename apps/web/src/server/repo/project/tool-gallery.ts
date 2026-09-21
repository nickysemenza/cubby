import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type {
  ToolGalleryFilters,
  ToolGalleryGroupBy,
  ToolGalleryGroupOut,
  ToolGalleryInventoryEntryOut,
  ToolGalleryItemOut,
  ToolGalleryOut,
  Trade,
} from "@cubby/schemas/project";
import { TRADE_LABELS, tradeValues } from "@cubby/schemas/project";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { loadLocationAncestors } from "~/server/repo/location/tree";
import { getProductImagesByProductIds } from "~/server/repo/product";
import { categoryFeatureSql } from "~/server/repo/product-category-sql";

import { deriveToolTrades } from "./tool-trades";
import { EMPTY_METRICS, loadResourceMetrics } from "./tools";

const MULTIPLE_LOCATIONS_KEY = "__multiple_locations__";
const UNCLASSIFIED_KEY = "";

type InventoryPlacementRow = {
  id: ToolGalleryInventoryEntryOut["id"];
  amount: ToolGalleryInventoryEntryOut["amount"];
  placement: ToolGalleryInventoryEntryOut["placement"];
  locationId: LocationId;
  location: Omit<ToolGalleryInventoryEntryOut["location"], "ancestors">;
};

type GalleryCandidate = {
  productId: ProductId;
  productCode: ToolGalleryItemOut["productId"];
  productName: string;
  aliases: string[];
  tags: string[];
  manufacturer: string;
  model: string | null;
  inventoryEntries: InventoryPlacementRow[];
};

type EnrichedCandidate = Omit<GalleryCandidate, "inventoryEntries"> & {
  inventoryEntries: ToolGalleryInventoryEntryOut[];
  trade: Trade | null;
  groupKey: string;
  groupLabel: string;
};

type GalleryGroupIdentity = {
  key: string;
  label: string;
};

function normalizedManufacturer(manufacturer: string): string | null {
  const trimmed = manufacturer.trim();
  return trimmed === "" ||
    trimmed.toLocaleLowerCase() === UNSPECIFIED_MANUFACTURER.toLocaleLowerCase()
    ? null
    : trimmed;
}

function locationPath(entry: ToolGalleryInventoryEntryOut): string[] {
  return [
    ...entry.location.ancestors.map((ancestor) => ancestor.name),
    entry.location.name,
  ];
}

function locationGroup(
  entry: ToolGalleryInventoryEntryOut,
): GalleryGroupIdentity {
  // Home is the inventory tree's structural root. A tool below it belongs to
  // the first household area; a tool stored directly at Home remains in Home.
  const topLevel =
    entry.location.ancestors.length > 1
      ? (entry.location.ancestors[1] ?? entry.location)
      : entry.location;
  return {
    key: topLevel.id,
    label: topLevel.name,
  };
}

export function toolGalleryGroup(
  candidate: Pick<
    EnrichedCandidate,
    "inventoryEntries" | "manufacturer" | "trade"
  >,
  groupBy: ToolGalleryGroupBy,
): GalleryGroupIdentity {
  if (groupBy === "manufacturer") {
    const manufacturer = normalizedManufacturer(candidate.manufacturer);
    return {
      key: manufacturer?.toLocaleLowerCase() ?? UNCLASSIFIED_KEY,
      label: manufacturer ?? "Unspecified",
    };
  }
  if (groupBy === "trade") {
    return {
      key: candidate.trade ?? UNCLASSIFIED_KEY,
      label: candidate.trade ? TRADE_LABELS[candidate.trade] : "Unclassified",
    };
  }
  const uniqueLocations = new Set(
    candidate.inventoryEntries.map((entry) => entry.location.id),
  );
  if (uniqueLocations.size > 1) {
    return { key: MULTIPLE_LOCATIONS_KEY, label: "Multiple locations" };
  }
  return locationGroup(candidate.inventoryEntries[0]!);
}

function groupRank(groupBy: ToolGalleryGroupBy, key: string): number {
  if (key === MULTIPLE_LOCATIONS_KEY || key === UNCLASSIFIED_KEY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (groupBy !== "trade") return 0;
  const index = tradeValues.findIndex((trade) => trade === key);
  return index === -1 ? Number.MAX_SAFE_INTEGER - 1 : index;
}

function compareCandidates(
  groupBy: ToolGalleryGroupBy,
  a: EnrichedCandidate,
  b: EnrichedCandidate,
): number {
  const rank = groupRank(groupBy, a.groupKey) - groupRank(groupBy, b.groupKey);
  if (rank !== 0) return rank;
  const group = a.groupLabel.localeCompare(b.groupLabel, undefined, {
    sensitivity: "base",
  });
  if (group !== 0) return group;
  const name = a.productName.localeCompare(b.productName, undefined, {
    sensitivity: "base",
  });
  if (name !== 0) return name;
  const manufacturer = a.manufacturer.localeCompare(b.manufacturer, undefined, {
    sensitivity: "base",
  });
  return manufacturer !== 0
    ? manufacturer
    : a.productCode.localeCompare(b.productCode);
}

export function toolGallerySearchText(
  candidate: Pick<
    EnrichedCandidate,
    | "productName"
    | "aliases"
    | "tags"
    | "manufacturer"
    | "model"
    | "inventoryEntries"
    | "groupLabel"
  >,
): string {
  return [
    candidate.productName,
    ...candidate.aliases,
    candidate.manufacturer,
    candidate.model,
    ...candidate.tags,
    ...candidate.inventoryEntries.flatMap(locationPath),
    candidate.groupLabel,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
}

/** One bounded read model for the inventory-led Tools gallery. */
export async function projectToolGallery(
  db: Database,
  filters: ToolGalleryFilters,
): Promise<ToolGalleryOut> {
  const dbc = getDb(db);
  const rows = await dbc
    .select({
      productId: product.id,
      productCode: product.shortcode,
      productName: product.name,
      aliases: product.aliases,
      tags: product.tags,
      manufacturer: product.manufacturer,
      model: product.model,
      inventoryId: inventoryEntry.shortcode,
      amount: inventoryEntry.amount,
      placement: inventoryEntry.placement,
      locationId: location.id,
      locationCode: location.shortcode,
      locationName: location.name,
    })
    .from(product)
    .innerJoin(
      inventoryEntry,
      and(eq(inventoryEntry.productId, product.id), notDeleted(inventoryEntry)),
    )
    .innerJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(
      and(
        categoryFeatureSql(sql`${product.categoryId}`, "tools"),
        notDeleted(product),
      ),
    )
    .orderBy(
      asc(product.name),
      asc(product.shortcode),
      asc(inventoryEntry.shortcode),
    );

  const candidatesById = new Map<ProductId, GalleryCandidate>();
  for (const row of rows) {
    const entry: InventoryPlacementRow = {
      id: parseShortcodeFor("inventory", row.inventoryId),
      amount: row.amount,
      placement: row.placement,
      locationId: row.locationId,
      location: {
        id: parseShortcodeFor("location", row.locationCode),
        name: row.locationName,
      },
    };
    const current = candidatesById.get(row.productId);
    if (current) {
      current.inventoryEntries.push(entry);
      continue;
    }
    candidatesById.set(row.productId, {
      productId: row.productId,
      productCode: parseShortcodeFor("product", row.productCode),
      productName: row.productName,
      aliases: row.aliases,
      tags: row.tags,
      manufacturer: row.manufacturer,
      model: row.model,
      inventoryEntries: [entry],
    });
  }

  const candidates = [...candidatesById.values()];
  const productIds = candidates.map((candidate) => candidate.productId);
  const locationIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.inventoryEntries.map((entry) => entry.locationId),
      ),
    ),
  ];
  const [ancestorsByLocation, trades] = await Promise.all([
    loadLocationAncestors(db, locationIds),
    deriveToolTrades(dbc, productIds),
  ]);

  const enriched = candidates.map<EnrichedCandidate>((candidate) => {
    const inventoryEntries = candidate.inventoryEntries.map(
      ({ locationId, ...entry }) => ({
        ...entry,
        location: {
          ...entry.location,
          ancestors: ancestorsByLocation.get(locationId) ?? [],
        },
      }),
    );
    const trade = trades.get(candidate.productId) ?? null;
    const { key: groupKey, label: groupLabel } = toolGalleryGroup(
      { inventoryEntries, manufacturer: candidate.manufacturer, trade },
      filters.groupBy,
    );
    return {
      ...candidate,
      inventoryEntries,
      trade,
      groupKey,
      groupLabel,
    };
  });

  const query = filters.search?.trim().toLocaleLowerCase();
  const matching = enriched
    .filter(
      (candidate) => !query || toolGallerySearchText(candidate).includes(query),
    )
    .sort((a, b) => compareCandidates(filters.groupBy, a, b));

  const groupsByKey = new Map<string, ToolGalleryGroupOut>();
  for (const [candidateIndex, candidate] of matching.entries()) {
    const current = groupsByKey.get(candidate.groupKey);
    if (current) current.itemCount += 1;
    else {
      groupsByKey.set(candidate.groupKey, {
        key: candidate.groupKey,
        label: candidate.groupLabel,
        itemCount: 1,
        startIndex: candidateIndex,
      });
    }
  }

  const { pageIndex, pageSize } = filters.pagination;
  const page = matching.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  const pageIds = page.map((candidate) => candidate.productId);
  const [imagesByProduct, metricsByProduct] = await Promise.all([
    getProductImagesByProductIds(db, pageIds),
    loadResourceMetrics(dbc, pageIds),
  ]);

  const items = page.map<ToolGalleryItemOut>((candidate) => {
    const images = (imagesByProduct[candidate.productId] ?? []).filter(
      isDisplayableImageFile,
    );
    const metrics = metricsByProduct.get(candidate.productId) ?? EMPTY_METRICS;
    return {
      productId: candidate.productCode,
      productName: candidate.productName,
      manufacturer: candidate.manufacturer,
      model: candidate.model,
      coverImageUrl: images[0]?.url ?? null,
      extraImageCount: Math.max(0, images.length - 1),
      inventoryEntries: candidate.inventoryEntries,
      trade: candidate.trade,
      groupKey: candidate.groupKey,
      groupLabel: candidate.groupLabel,
      ...metrics,
    };
  });

  return {
    meta: { pageIndex, pageSize, totalCount: matching.length },
    items,
    groups: [...groupsByKey.values()],
    totals: {
      products: matching.length,
      placements: matching.reduce(
        (sum, candidate) => sum + candidate.inventoryEntries.length,
        0,
      ),
    },
  };
}

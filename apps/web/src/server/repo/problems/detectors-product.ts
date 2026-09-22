import { displayGtin, GTIN_SOURCE } from "@cubby/schemas/external-id";
/**
 * Product-centric Problems detectors.
 *
 * Duplicate unique products, orphaned (no-inventory) products, products with no
 * conversion/price coverage, fresh-UPC enrichment candidates, the shared
 * effective-mapping synthesis, plus the coverage data pull, recipe-usage counts,
 * and linked-product-id lookup the service layer composes.
 */
import type {
  IngredientId,
  ProductId,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  DuplicateProductIdentity,
  OrphanedProduct,
  ProductWithBetterUpcData,
  ToolUsedOutsideOwnership,
  WeightSoldProduct,
} from "@cubby/schemas/problems";
import type { ProductCategorySummary } from "@cubby/schemas/product-category-fields";
import { isMiscProduct } from "@cubby/shared";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";

import { householdLocalDate } from "~/lib/household-date";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { sizeUnitAlternation } from "~/lib/title-unit-size";
import { toolTimelineConflict, UNKNOWN_OWNERSHIP } from "~/lib/tool-timeline";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { Database, DrizzleClient } from "~/server/db";
import {
  cookbook,
  device,
  photoGroupProposal,
  expense,
  image,
  importRunTarget,
  ingredient,
  inventoryEntry,
  location,
  mealFoodEntry,
  product,
  planting,
  productComponent,
  productExternalId,
  productImage,
  productUnitMappings,
  project,
  projectToolUsage,
  purchaseProduct,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  task,
  wishCandidate,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { canonicalLabelKey } from "~/server/repo/label-canonical";
import {
  categoryFeatureSql,
  categorySummarySql,
} from "~/server/repo/product-category-sql";
import {
  isRetainingEdgeKey,
  PRODUCT_EDGE_ROLES,
  type ProductRetainingEdgeKey,
} from "~/server/repo/product/edge-roles";
import {
  loadPrimaryGtins,
  productHasAnyGtin,
} from "~/server/repo/product/gtin";
import {
  loadProductOwnershipTimelines,
  ownershipExitExpensePredicate,
} from "~/server/repo/product/ownership";
import { loadProductPricing } from "~/server/repo/product/pricing";
import { loadProjectDateWindows } from "~/server/repo/project/subtree";
import { buildTimelineGates } from "~/server/repo/project/tools";
import { effectiveTaskSubjectProductSql } from "~/server/repo/task-project-inheritance";

export type { ProductWithBetterUpcData };

type ProductWithUpcGapCandidate = {
  id: ProductId;
  shortcode: ProductShortcode;
  name: string;
  manufacturer: string;
  upc: string;
  effectivePrice: number | null;
  hasImage: boolean;
};

/** Orphan suggestions are not a saved predicate: delete eligibility must use the canonical incoming-edge policy. */
const PRODUCT_RETAINING_NOT_EXISTS = {
  "ImportRunTarget.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(importRunTarget)
        .where(eq(importRunTarget.productId, product.id)),
    ),
  "Planting.sourceProductId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(planting)
        .where(
          and(eq(planting.sourceProductId, product.id), notDeleted(planting)),
        ),
    ),
  "InventoryEntry.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(inventoryEntry)
        .where(
          and(
            eq(inventoryEntry.productId, product.id),
            notDeleted(inventoryEntry),
          ),
        ),
    ),
  // Unlike the `productIdsWithExpenses` subquery in product/crud.ts, this
  // needs no `isNotNull(expense.productId)`: that one is an uncorrelated
  // NOT IN list, where a single NULL makes the whole predicate UNKNOWN. A
  // correlated `eq` simply never matches NULL.
  "Expense.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(expense)
        .where(and(eq(expense.productId, product.id), notDeleted(expense))),
    ),
  "Task.subjectProductId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(task)
        .where(
          and(
            eq(effectiveTaskSubjectProductSql(), product.id),
            notDeleted(task),
          ),
        ),
    ),
  "ProjectToolUsage.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(projectToolUsage)
        .where(
          and(
            eq(projectToolUsage.productId, product.id),
            notDeleted(projectToolUsage),
          ),
        ),
    ),
  "PurchaseProduct.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(purchaseProduct)
        .where(
          and(
            eq(purchaseProduct.productId, product.id),
            notDeleted(purchaseProduct),
          ),
        ),
    ),
  "MealFoodEntry.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(mealFoodEntry)
        .where(
          and(
            eq(mealFoodEntry.productId, product.id),
            notDeleted(mealFoodEntry),
          ),
        ),
    ),
  "WishCandidate.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(wishCandidate)
        .where(
          and(
            eq(wishCandidate.productId, product.id),
            notDeleted(wishCandidate),
          ),
        ),
    ),
  "Location.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(location)
        .where(and(eq(location.productId, product.id), notDeleted(location))),
    ),
  "Cookbook.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(cookbook)
        .where(and(eq(cookbook.productId, product.id), notDeleted(cookbook))),
    ),
  "ProductComponent.componentProductId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(productComponent)
        .where(
          and(
            eq(productComponent.componentProductId, product.id),
            notDeleted(productComponent),
          ),
        ),
    ),
  "Device.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(device)
        .where(and(eq(device.productId, product.id), notDeleted(device))),
    ),
  // Only a still-pending proposal intends to use the Product; a committed
  // one is history and must not hide an otherwise-orphaned Product forever.
  "PhotoGroupProposal.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(photoGroupProposal)
        .where(
          and(
            eq(photoGroupProposal.productId, product.id),
            eq(photoGroupProposal.state, "proposed"),
          ),
        ),
    ),
} satisfies Record<ProductRetainingEdgeKey, (dbClient: DrizzleClient) => SQL>;

/** Orphan candidates have no live evidence; deletion remains a transactional canonical-policy decision. */
export const findOrphanedProducts = async (
  db: Database,
): Promise<OrphanedProduct[]> => {
  const dbClient = getDb(db);

  const orphaned = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      shortcode: product.shortcode,
      createdAt: product.createdAt,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNull(product.ingredientId),
        ...Object.keys(PRODUCT_EDGE_ROLES)
          .filter(isRetainingEdgeKey)
          .map((key) => PRODUCT_RETAINING_NOT_EXISTS[key](dbClient)),
        // A composition parent owns no retaining incoming edge: deleting it
        // merely removes its ProductComponent rows. It is still a meaningful
        // live product, though, so offering it as an orphan would discard the
        // kit or multi-pack identity represented by those rows.
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(productComponent)
            .where(
              and(
                eq(productComponent.parentProductId, product.id),
                notDeleted(productComponent),
              ),
            ),
        ),
      ),
    );

  return orphaned.map((row) => ({
    ...row,
    id: parseShortcodeFor("product", row.shortcode),
  }));
};

/**
 * Disposal totals for card rows selected by the canonical Product list.
 * This is hydration only: the caller supplies the exact page shortcodes, so
 * no quantity/inventory eligibility predicate is repeated here.
 */
export const loadSoldButStockedPresenterTotals = async (
  db: Database,
  shortcodes: readonly string[],
): Promise<
  Map<
    string,
    {
      soldQuantity: number;
      proceeds: number;
      servingLocations: { id: string; name: string }[];
    }
  >
> => {
  if (shortcodes.length === 0) return new Map();
  const dbClient = getDb(db);
  const [rows, servingRows] = await Promise.all([
    dbClient
      .select({
        shortcode: product.shortcode,
        soldQuantity: sql<number>`sum(coalesce(abs(${expense.productQuantity}), 1))::double precision`,
        proceeds: sql<number>`sum(${expense.cost})::double precision`,
      })
      .from(expense)
      .innerJoin(product, eq(product.id, expense.productId))
      .where(
        and(
          notDeleted(expense),
          notDeleted(product),
          inArray(product.shortcode, [...shortcodes]),
          eq(expense.future, false),
          ownershipExitExpensePredicate(dbClient),
        ),
      )
      .groupBy(product.shortcode),
    dbClient
      .select({
        productShortcode: product.shortcode,
        id: location.shortcode,
        name: location.name,
      })
      .from(location)
      .innerJoin(product, eq(product.id, location.productId))
      .where(
        and(
          notDeleted(location),
          notDeleted(product),
          inArray(product.shortcode, [...shortcodes]),
        ),
      ),
  ]);
  const servingByProduct = new Map<string, { id: string; name: string }[]>();
  for (const row of servingRows) {
    const locations = servingByProduct.get(row.productShortcode) ?? [];
    locations.push({
      id: parseShortcodeFor("location", row.id),
      name: row.name,
    });
    servingByProduct.set(row.productShortcode, locations);
  }
  return new Map(
    rows.map((row) => [
      row.shortcode,
      {
        soldQuantity: Number(row.soldQuantity),
        proceeds: Number(row.proceeds),
        servingLocations: servingByProduct.get(row.shortcode) ?? [],
      },
    ]),
  );
};

export const findToolsUsedOutsideOwnership = async (
  db: Database,
  options: { today?: string } = {},
): Promise<ToolUsedOutsideOwnership[]> => {
  const dbClient = getDb(db);
  const today = options.today ?? householdLocalDate();

  const edges = await dbClient
    .select({
      projectId: projectToolUsage.projectId,
      projectShortcode: project.shortcode,
      projectName: project.name,
      productId: projectToolUsage.productId,
      productShortcode: product.shortcode,
      productName: product.name,
      manufacturer: product.manufacturer,
    })
    .from(projectToolUsage)
    .innerJoin(
      project,
      and(eq(project.id, projectToolUsage.projectId), notDeleted(project)),
    )
    .innerJoin(
      product,
      and(eq(product.id, projectToolUsage.productId), notDeleted(product)),
    )
    .where(notDeleted(projectToolUsage));
  if (edges.length === 0) return [];

  const [loadedWindows, ownership] = await Promise.all([
    loadProjectDateWindows(db),
    loadProductOwnershipTimelines(
      dbClient,
      uniq(edges.map((edge) => edge.productId)),
      { today },
    ),
  ]);
  const gates = buildTimelineGates(
    loadedWindows,
    uniq(edges.map((edge) => edge.projectId)),
  );

  const rows: ToolUsedOutsideOwnership[] = [];
  for (const edge of edges) {
    const gate = gates.get(edge.projectId);
    if (!gate) continue;
    const conflict = toolTimelineConflict(
      ownership.get(edge.productId) ?? UNKNOWN_OWNERSHIP,
      gate.window,
      { isLive: gate.isLive, today },
    );
    if (!conflict) continue;
    rows.push({
      id: parseShortcodeFor("product", edge.productShortcode),
      name: edge.productName,
      manufacturer: edge.manufacturer,
      projectId: parseShortcodeFor("project", edge.projectShortcode),
      projectName: edge.projectName,
      conflict: conflict.kind,
      toolDate: conflict.date,
      projectBoundary: conflict.boundary,
    });
  }
  return rows.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      a.name.localeCompare(b.name),
  );
};

/** Name variants are merge suggestions only: candidates must not share live evidence and never auto-merge. */
export const findDuplicateProductIdentities = async (
  db: Database,
): Promise<DuplicateProductIdentity[]> => {
  const dbClient = getDb(db);
  const manufacturerKey = canonicalLabelKey(product.manufacturer);
  // JavaScript's trim/lower contract is authoritative below. On ASCII-only
  // models, this SQL form is identical (the vertical tab is octal because
  // PostgreSQL escape strings do not spell it as `\v`). Any manufacturer that
  // contains a non-ASCII model takes the conservative fallback path below,
  // since JavaScript handles Unicode whitespace/case differently.
  const asciiModelKey = sql<string>`lower(btrim(${product.model}, E' \\t\\n\\r\\f\\013'))`;
  const isAsciiModel = sql`${product.model} ~ '^[[:ascii:]]*$'`;
  // Keep the first read to model groups that can actually produce a duplicate,
  // except for the Unicode fallback described above. The semantic exclusions
  // below remain in TypeScript because `isMiscProduct` and
  // `isUnspecifiedManufacturer` are shared application predicates, not SQL
  // policy; a group can therefore still be discarded after this prefilter.
  const duplicateAsciiModelGroups = dbClient
    .select({
      manufacturerKey: manufacturerKey.as("manufacturerKey"),
      modelKey: asciiModelKey.as("modelKey"),
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNotNull(product.model),
        isAsciiModel,
        sql`${asciiModelKey} <> ''`,
      ),
    )
    .groupBy(manufacturerKey, asciiModelKey)
    .having(sql`count(*) > 1`)
    .as("duplicate_product_identity_ascii_groups");

  const manufacturersWithNonAsciiModels = dbClient
    .select({
      manufacturerKey: manufacturerKey.as("manufacturerKey"),
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNotNull(product.model),
        sql`NOT ${isAsciiModel}`,
      ),
    )
    .groupBy(manufacturerKey)
    .as("product_manufacturers_with_non_ascii_models");

  const belongsToDuplicateAsciiModelGroup = exists(
    dbClient
      .select({ one: sql`1` })
      .from(duplicateAsciiModelGroups)
      .where(
        and(
          eq(duplicateAsciiModelGroups.manufacturerKey, manufacturerKey),
          eq(duplicateAsciiModelGroups.modelKey, asciiModelKey),
        ),
      ),
  );
  const belongsToUnicodeFallbackManufacturer = exists(
    dbClient
      .select({ one: sql`1` })
      .from(manufacturersWithNonAsciiModels)
      .where(
        eq(manufacturersWithNonAsciiModels.manufacturerKey, manufacturerKey),
      ),
  );

  const rows = await dbClient
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
      // The SAME canonical key `findManufacturerSpellingVariants` and
      // `resolveEstablishedManufacturer` use, so `Ryobi`/`RYOBI` can't split a
      // real duplicate apart before this detector can group it.
      manufacturerKey,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNotNull(product.model),
        or(
          belongsToDuplicateAsciiModelGroup,
          belongsToUnicodeFallbackManufacturer,
        ),
      ),
    );

  const candidates = rows.filter(
    (row): row is typeof row & { model: string } =>
      row.model != null &&
      row.model.trim() !== "" &&
      !isUnspecifiedManufacturer(row.manufacturer) &&
      !isMiscProduct(row.name),
  );
  if (candidates.length === 0) return [];

  const identifiers = await dbClient
    .select({
      productId: productExternalId.productId,
      source: productExternalId.source,
      kind: productExternalId.kind,
      externalId: productExternalId.externalId,
    })
    .from(productExternalId)
    .where(
      and(
        inArray(
          productExternalId.productId,
          candidates.map((row) => row.id),
        ),
        notDeleted(productExternalId),
      ),
    );

  const byProduct = new Map<
    string,
    Array<{ source: string; kind: string; externalId: string }>
  >();
  for (const row of identifiers) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }

  // Model is an exact identifier, so only case and surrounding whitespace are
  // normalized away; the manufacturer half of the key was canonicalized in SQL.
  const groups = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = `${row.manufacturerKey}\u0000${row.model.trim().toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const out: DuplicateProductIdentity[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const withIds = group.filter(
      (row) => (byProduct.get(row.id) ?? []).length > 0,
    );
    if (withIds.length < 2) continue;
    const sources = uniq(
      withIds.flatMap((row) =>
        (byProduct.get(row.id) ?? []).map((id) => id.source),
      ),
    );
    if (sources.length < 2) continue;

    const bySlot = new Map<string, Set<string>>();
    for (const row of group) {
      for (const id of byProduct.get(row.id) ?? []) {
        const slot = `${id.source}\u0000${id.kind}`;
        const values = bySlot.get(slot) ?? new Set<string>();
        values.add(id.externalId);
        bySlot.set(slot, values);
      }
    }
    if ([...bySlot.values()].some((values) => values.size > 1)) continue;

    out.push({
      manufacturer: group[0]!.manufacturer,
      model: group[0]!.model,
      products: group.map((row) => ({
        id: parseShortcodeFor("product", row.shortcode),
        name: row.name,
        gtins: (byProduct.get(row.id) ?? [])
          .filter((id) => id.source === GTIN_SOURCE)
          .map((id) => id.externalId)
          .sort(),
        sources: uniq(
          (byProduct.get(row.id) ?? []).map((id) => id.source),
        ).sort(),
      })),
    });
  }

  return out;
};

// Synthesize a product's *effective* conversion edges (stored mappings + price
// edge + USDA portion/serving/nutrient edges) — the same set the conversion
// graph and costing engine use. Returns null (after logging) when the WASM
// synthesis throws, so callers can skip the product instead of failing the scan.
export const synthesizeEffectiveMappings = (
  p: { name: string } & Parameters<typeof getAllUnitMappingsFromProduct>[0],
): ReturnType<typeof getAllUnitMappingsFromProduct> | null => {
  try {
    return getAllUnitMappingsFromProduct(p);
  } catch (error) {
    console.error(
      `Failed to synthesize mappings for product ${p.id} (${p.name}):`,
      error,
    );
    return null;
  }
};

// ProductWithBetterUpcData (productWithBetterUpcDataSchema): a product whose
// stored UPC-sourced fields have a gap (no manufacturer, price, or image) that
// a *fresh* UPC lookup could fill. A purchase-derived price already closes the
// price gap. `proposed` carries the value the live lookup would write per field
// (null ⇒ no change), so the panel can show the actual before→after, not just
// which fields are missing.

// DB-only prefilter for ProductWithBetterUpcData. The service layer owns the UPC
// client call and proposed-value construction; the repo layer only identifies
// products with stored UPC-sourced gaps that are worth looking up.
export const findProductsWithUpcGaps = async (
  db: Database,
): Promise<ProductWithUpcGapCandidate[]> => {
  const dbClient = getDb(db);

  const rows = await dbClient
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      price: product.price,
      // Must agree with `productIdsWithImages` in product/crud.ts, and with
      // findProductsWithNoImages in product/analytics.ts: Image is separately
      // soft-deletable from ProductImage, and a PDF is a manual, not a photo.
      // Checking ProductImage alone reads `true` for a product whose only
      // attachment is a PDF, which then gets filtered out of the candidate list
      // below and never gets the UPC lookup that would fetch it a real photo —
      // hitting tools and hardware hardest.
      hasImage: exists(
        dbClient
          .select({ id: sql`1` })
          .from(productImage)
          .innerJoin(
            image,
            and(eq(image.id, productImage.imageId), notDeleted(image)),
          )
          .where(
            and(
              eq(productImage.productId, product.id),
              notDeleted(productImage),
              displayableImageWhere,
            ),
          ),
      ),
    })
    .from(product)
    .where(and(notDeleted(product), productHasAnyGtin()));

  const gtins = await loadPrimaryGtins(
    db,
    rows.map((r) => r.id),
  );
  const pricing = await loadProductPricing(db, rows);

  // No-network candidate filter: only gappy, non-misc products need a lookup.
  // `displayGtin`, not the stored GTIN-14: this value is handed to the UPC
  // provider, which indexes the printed encoding.
  const candidates = rows
    .map((r) => {
      const stored = gtins.get(r.id) ?? null;
      return {
        ...r,
        upc: stored === null ? null : displayGtin(stored),
        effectivePrice: pricing.get(r.id)?.effectivePrice ?? null,
      };
    })
    .filter(
      (r): r is typeof r & { upc: string } =>
        r.upc != null &&
        !isMiscProduct(r.name) &&
        (isUnspecifiedManufacturer(r.manufacturer) ||
          r.effectivePrice == null ||
          !r.hasImage),
    );

  return candidates.map((candidate) => ({
    ...candidate,
    shortcode: parseShortcodeFor("product", candidate.shortcode),
    hasImage: Boolean(candidate.hasImage),
  }));
};

// Distinct non-deleted recipes each product feeds into, via its linked
// ingredient (product → ingredient → recipeSectionIngredient → recipe). A
// prioritization signal for the Problems page: a data gap on a product used in
// 12 recipes matters more than one used in none. Only products that HAVE an
// ingredient are returned (with a count that may be 0); non-food products are
// omitted, so the card can tell "0 recipes" apart from "no ingredient link".
export const recipeUsageCountsByProduct = async (
  db: Database,
  productShortcodes: string[],
): Promise<Record<string, number>> => {
  if (productShortcodes.length === 0) return {};

  const rows = await getDb(db)
    .select({
      shortcode: product.shortcode,
      count: sql<number>`count(distinct ${recipe.id})`,
    })
    .from(product)
    .leftJoin(
      recipeSectionIngredient,
      and(
        eq(recipeSectionIngredient.ingredientId, product.ingredientId),
        notDeleted(recipeSectionIngredient),
      ),
    )
    .leftJoin(
      recipeSection,
      and(
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
        notDeleted(recipeSection),
      ),
    )
    .leftJoin(
      recipe,
      and(eq(recipe.id, recipeSection.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(product),
        isNotNull(product.ingredientId),
        inArray(product.shortcode, productShortcodes),
      ),
    )
    .groupBy(product.shortcode);

  return Object.fromEntries(rows.map((r) => [r.shortcode, Number(r.count)]));
};

// DB pull shared by BOTH coverage detectors (partial-coverage + islanding):
// every non-deleted product with its stored mappings, the fields needed to
// synthesize derived edges (USDA link + price), and the linked ingredient's
// naKinds. A superset of both detectors' needs, so the service can run one scan,
// one USDA enrichment, and one effective-mapping synthesis per product instead
// of doing all of it twice (the perf win behind the always-on navbar badge).
// The coverage grading (USDA enrichment, synthesis, conversionCoverage,
// islanding) all lives in the service.
// Carries `shortcode` (product) and `ingredient.shortcode` — needed by the
// service layer to populate `IngredientWithPartialCoverage.shortcode`/
// `ingredientShortcode` and `ProductWithIslandedMappings.shortcode` (see
// problems.service.ts's `findProductCoverageProblems`, which owns assembling
// those rows and currently omits both fields from its push()es).
export const loadProductsForCoverage = async (
  db: Database,
  productIds?: readonly ProductId[],
) => {
  const rows = await getDb(db).query.product.findMany({
    where:
      productIds == null
        ? notDeleted(product)
        : and(notDeleted(product), inArray(product.id, [...productIds])),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      shortcode: true,
      fdc_id: true,
      labelNutrition: true,
      price: true,
      usdaUnavailable: true,
      ingredientId: true,
      categoryId: true,
    },
    extras: {
      category: categorySummarySql(sql`${product.categoryId}`).as("category"),
    },
    with: {
      unitMappings: {
        where: notDeleted(productUnitMappings),
        columns: { a: true, b: true, source: true },
      },
      // The linked ingredient's N/A opt-outs, so partial coverage grades only the
      // kinds that apply (a count-only item isn't flagged for a volume it never uses).
      ingredient: { columns: { naKinds: true, shortcode: true } },
    },
  });
  const pricing = await loadProductPricing(db, rows, {
    wholeCatalog: productIds == null,
  });
  const gtins = await loadPrimaryGtins(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    ...row,
    price: pricing.get(row.id)?.effectivePrice ?? null,
    primaryGtin: gtins.get(row.id) ?? null,
  }));
};

/** Title-size proposals use the shared grammar only to narrow candidates; canonical costing remains authoritative. */
export const findProductsWithoutUnitMappings = async (
  db: Database,
): Promise<
  {
    shortcode: ProductShortcode;
    name: string;
    manufacturer: string;
    category: ProductCategorySummary | null;
  }[]
> => {
  const dbClient = getDb(db);
  const rows = await dbClient
    .select({
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      category: categorySummarySql(sql`${product.categoryId}`),
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        or(
          categoryFeatureSql(sql`${product.categoryId}`, "food"),
          isNotNull(product.ingredientId),
          gt(product.fdc_id, 0),
        ),
        // Derive unit spellings from the WASM grammar; hand-maintained SQL aliases drifted from parser semantics.
        sql.raw(
          `"Product"."name" ~* '[0-9][[:space:]]*(${sizeUnitAlternation()})\\M'`,
        ),
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(productUnitMappings)
            .where(
              and(
                eq(productUnitMappings.productId, product.id),
                notDeleted(productUnitMappings),
              ),
            ),
        ),
      ),
    );

  return rows
    .filter((row) => !isMiscProduct(row.name))
    .map((row) => ({
      ...row,
      shortcode: parseShortcodeFor("product", row.shortcode),
    }));
};

// Ids of an ingredient's non-deleted, linked products. Used by the
// deleteUnusedIngredients orchestrator to delete those products first so the
// ingredient delete's linked-product guard passes.
export const findLinkedProductIds = async (
  db: Database,
  ingredientId: IngredientId,
): Promise<ProductId[]> => {
  const linked = await getDb(db).query.product.findMany({
    where: and(eq(product.ingredientId, ingredientId), notDeleted(product)),
    columns: { id: true },
  });
  return linked.map((p) => p.id);
};

/**
 * Products priced by weight whose expense lines claim a fixed quantity, so the
 * derived per-each price averages items that each weighed something different.
 * See `weightSoldProductSchema` for why this is invisible to the neighbouring
 * detectors and what the fix is.
 *
 * Pure SQL over indexed FK joins, so it belongs in the `fast` cost group.
 *
 * Thresholds are deliberately conservative — this is a worklist, and a false
 * positive costs a human read of a product page:
 *   - `>= 3` priced lines, so a one-off sale can't establish a spread
 *   - `>= 2x` between the cheapest and dearest unit cost
 *   - `>= 0.75` distinct-price fraction, which is what separates weight-sold
 *     goods from packaged ones whose price drifted (see the schema doc)
 * Products that already carry a unit mapping are excluded: the mapping IS the
 * fix, so keeping them would make the section permanently red.
 */
export const findWeightSoldProducts = async (
  db: Database,
): Promise<WeightSoldProduct[]> => {
  const res = await getDb(db).execute<{
    id: string;
    name: string;
    manufacturer: string;
    lineCount: number;
    distinctPriceFraction: number;
    lowUnitCost: number;
    highUnitCost: number;
    ingredientId: string | null;
  }>(sql`
    WITH priced_lines AS (
      SELECT
        e."productId" AS product_id,
        -- A null quantity is the weight-sold tell itself (the importer could not
        -- read a count off the line), so it folds to 1 rather than dropping the
        -- row. Sign is carried by cost, so quantity is taken absolute.
        round(
          (e."cost" / NULLIF(ABS(COALESCE(e."productQuantity", 1)), 0))::numeric,
          2
        ) AS unit_cost
      FROM ${expense} e
      WHERE e."deletedAt" IS NULL
        AND e."productId" IS NOT NULL
        AND e."lineKind" = 'principal'
        AND e."cost" > 0
    ),
    spread AS (
      SELECT
        product_id,
        count(*)::int AS line_count,
        count(DISTINCT unit_cost)::int AS distinct_count,
        min(unit_cost) AS low_unit_cost,
        max(unit_cost) AS high_unit_cost
      FROM priced_lines
      WHERE unit_cost IS NOT NULL
      GROUP BY product_id
    )
    SELECT
      p."shortcode" AS id,
      p."name" AS name,
      p."manufacturer" AS manufacturer,
      s.line_count AS "lineCount",
      round(s.distinct_count::numeric / s.line_count, 2)::float8 AS "distinctPriceFraction",
      s.low_unit_cost::float8 AS "lowUnitCost",
      s.high_unit_cost::float8 AS "highUnitCost",
      i."shortcode" AS "ingredientId"
    FROM spread s
    INNER JOIN ${product} p ON p.id = s.product_id AND p."deletedAt" IS NULL
    LEFT JOIN ${ingredient} i
      ON i.id = p."ingredientId" AND i."deletedAt" IS NULL
    WHERE s.line_count >= 3
      AND s.low_unit_cost > 0
      AND s.high_unit_cost / s.low_unit_cost >= 2
      AND s.distinct_count::numeric / s.line_count >= 0.75
      AND NOT EXISTS (
        SELECT 1 FROM ${productUnitMappings} m
        WHERE m."productId" = p.id AND m."deletedAt" IS NULL
      )
    ORDER BY s.line_count DESC, p."name" ASC
  `);

  return res.rows.map((row) => ({
    id: parseShortcodeFor("product", row.id),
    name: row.name,
    manufacturer: row.manufacturer,
    lineCount: row.lineCount,
    distinctPriceFraction: row.distinctPriceFraction,
    lowUnitCost: row.lowUnitCost,
    highUnitCost: row.highUnitCost,
    ingredientId:
      row.ingredientId === null
        ? null
        : parseShortcodeFor("ingredient", row.ingredientId),
  }));
};

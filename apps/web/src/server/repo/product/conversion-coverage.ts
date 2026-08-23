/** Persistence seam for the catalog-wide conversion projection. */
import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  product,
  productComponent,
  productConversionCoverage,
} from "~/server/db/schema";
import { getDb, unwrapDb } from "~/server/repo/database-helpers";

const PRODUCT_CONVERSION_COVERAGE_ENGINE_VERSION = "conversion-coverage-v1";

// USDA is an external input to the shared conversion graph. We do not get an
// upstream change feed, so a bounded refresh window is the durable invalidation
// policy for otherwise unchanged product rows.
const PRODUCT_CONVERSION_COVERAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const currentProductConversionCoverageCondition = () =>
  and(
    eq(productConversionCoverage.status, "ready"),
    eq(
      productConversionCoverage.engineVersion,
      PRODUCT_CONVERSION_COVERAGE_ENGINE_VERSION,
    ),
    sql`${productConversionCoverage.computedAt} >= now() - interval '7 days'`,
  );

export type ProductConversionCoverageProjection = {
  productId: ProductId;
  coverageTier: string;
  coveredKinds: string[];
  applicableKinds: string[];
  islandCount: number;
  status: "ready" | "unavailable";
};

/**
 * The catalog-level truthfulness signal for filters backed by the conversion
 * projection. A ready row from another engine version is deliberately stale:
 * the list filters fail closed in that case, so reporting it as fresh would
 * turn a partial result into a healthy-looking empty Problem.
 */
export type ProductConversionCoverageFreshness = {
  state: "fresh" | "stale" | "unavailable";
  computedAt: Date | null;
  expectedEngineVersion: string;
  readyCount: number;
  staleCount: number;
  unavailableCount: number;
  missingCount: number;
};

/**
 * Read only the small projection metadata relation. This never evaluates the
 * conversion graph or calls USDA; rebuilds remain in the dedicated coverage
 * lane/backfill workflow.
 */
export const getProductConversionCoverageFreshness = async (
  db: Database,
  now = new Date(),
): Promise<ProductConversionCoverageFreshness> => {
  const freshAfter = new Date(
    now.getTime() - PRODUCT_CONVERSION_COVERAGE_MAX_AGE_MS,
  );
  const [row] = await getDb(db)
    .select({
      computedAt: sql<Date | null>`max(${productConversionCoverage.computedAt})`,
      readyCount: sql<number>`count(*) filter (where ${productConversionCoverage.status} = 'ready' and ${productConversionCoverage.engineVersion} = ${PRODUCT_CONVERSION_COVERAGE_ENGINE_VERSION} and ${productConversionCoverage.computedAt} >= ${freshAfter})::int`,
      staleCount: sql<number>`count(*) filter (where ${productConversionCoverage.status} is not null and ${productConversionCoverage.status} <> 'unavailable' and (${productConversionCoverage.status} <> 'ready' or ${productConversionCoverage.engineVersion} <> ${PRODUCT_CONVERSION_COVERAGE_ENGINE_VERSION} or ${productConversionCoverage.computedAt} is null or ${productConversionCoverage.computedAt} < ${freshAfter}))::int`,
      unavailableCount: sql<number>`count(*) filter (where ${productConversionCoverage.status} = 'unavailable')::int`,
      missingCount: sql<number>`count(*) filter (where ${productConversionCoverage.status} is null)::int`,
    })
    .from(product)
    .leftJoin(
      productConversionCoverage,
      eq(productConversionCoverage.productId, product.id),
    )
    .where(isNull(product.deletedAt));

  const readyCount = row?.readyCount ?? 0;
  const staleCount = row?.staleCount ?? 0;
  const unavailableCount = row?.unavailableCount ?? 0;
  const missingCount = row?.missingCount ?? 0;

  return {
    state:
      unavailableCount > 0
        ? "unavailable"
        : staleCount > 0 || missingCount > 0
          ? "stale"
          : "fresh",
    computedAt: row?.computedAt ?? null,
    expectedEngineVersion: PRODUCT_CONVERSION_COVERAGE_ENGINE_VERSION,
    readyCount,
    staleCount,
    unavailableCount,
    missingCount,
  };
};

/**
 * Bounded presentation hydration for rows already selected by a canonical
 * projection-backed list query. This deliberately has no predicate semantics:
 * callers must not use it to decide membership or order.
 */
export const loadProductConversionCoverageProjection = async (
  db: Database,
  productIds: readonly ProductId[],
): Promise<Map<ProductId, ProductConversionCoverageProjection>> => {
  if (productIds.length === 0) return new Map();
  const rows = await getDb(db)
    .select({
      productId: productConversionCoverage.productId,
      coverageTier: productConversionCoverage.coverageTier,
      coveredKinds: productConversionCoverage.coveredKinds,
      applicableKinds: productConversionCoverage.applicableKinds,
      islandCount: productConversionCoverage.islandCount,
      status: productConversionCoverage.status,
    })
    .from(productConversionCoverage)
    .where(inArray(productConversionCoverage.productId, [...productIds]));
  return new Map(
    rows.map((row) => [
      row.productId,
      {
        ...row,
        status: row.status as ProductConversionCoverageProjection["status"],
      },
    ]),
  );
};

export const writeProductConversionCoverageProjection = async (
  db: Database,
  rows: readonly ProductConversionCoverageProjection[],
): Promise<void> => {
  if (rows.length === 0) return;
  const now = new Date();
  await getDb(db)
    .insert(productConversionCoverage)
    .values(
      rows.map((row) => ({
        ...row,
        engineVersion: PRODUCT_CONVERSION_COVERAGE_ENGINE_VERSION,
        computedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: productConversionCoverage.productId,
      set: {
        coverageTier: sql`excluded."coverageTier"`,
        coveredKinds: sql`excluded."coveredKinds"`,
        applicableKinds: sql`excluded."applicableKinds"`,
        islandCount: sql`excluded."islandCount"`,
        status: sql`excluded."status"`,
        engineVersion: PRODUCT_CONVERSION_COVERAGE_ENGINE_VERSION,
        computedAt: now,
      },
    });
};

/** Mark rows stale synchronously when a product mutation changes graph inputs. */
const markProductConversionCoverageStale = async (
  db: Database | DrizzleTransaction,
  productIds: readonly ProductId[],
): Promise<void> => {
  if (productIds.length === 0) return;
  await unwrapDb(db)
    .update(productConversionCoverage)
    .set({ status: "stale" })
    .where(inArray(productConversionCoverage.productId, [...productIds]));
};

/**
 * A conversion input change propagates up every containing kit. Component
 * graphs are validated acyclic when edges are written, but this traversal is
 * still cycle-safe so an old/bad row cannot loop a mutation forever.
 */
export const markProductConversionCoverageInputStale = async (
  db: Database | DrizzleTransaction,
  productIds: readonly ProductId[],
): Promise<void> => {
  const affected = new Set<ProductId>(productIds);
  let frontier = [...affected];
  const dbc = unwrapDb(db);
  while (frontier.length > 0) {
    const parents = await dbc
      .select({ productId: productComponent.parentProductId })
      .from(productComponent)
      .where(
        and(
          inArray(productComponent.componentProductId, frontier),
          isNull(productComponent.deletedAt),
        ),
      );
    frontier = parents
      .map((row) => row.productId)
      .filter((id) => {
        if (affected.has(id)) return false;
        affected.add(id);
        return true;
      });
  }
  await markProductConversionCoverageStale(db, [...affected]);
};

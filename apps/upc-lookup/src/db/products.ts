import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { chunk, clamp } from "es-toolkit";
import pMap from "p-map";
import type { Database } from "./index";
import { schema } from "./index";
import type { Env } from "../types";
import { cleanupImageVariants, deleteImageVariants } from "../storage/images";
import type { Product, NewProduct } from "./schema";

// D1 caps bound parameters per statement; chunk IN-lists well under the limit.
const IN_CHUNK = 100;

export async function getProduct(
  db: Database,
  upc: string,
): Promise<Product | undefined> {
  return db.query.products.findFirst({
    where: eq(schema.products.upc, upc),
  });
}

export async function getProducts(
  db: Database,
  upcs: string[],
): Promise<Product[]> {
  if (upcs.length === 0) return [];
  const batches = await pMap(
    chunk(upcs, IN_CHUNK),
    (batch) =>
      db.query.products.findMany({
        where: inArray(schema.products.upc, batch),
      }),
    { concurrency: 5 },
  );
  return batches.flat();
}

export async function createProduct(
  db: Database,
  values: NewProduct,
): Promise<Product> {
  const [row] = await db.insert(schema.products).values(values).returning();
  // `returning()` is typed as a (possibly-empty) array; an insert always yields
  // one row, so a missing row is a real failure, not a `Product`-typed undefined.
  if (!row) throw new Error("createProduct: insert returned no rows");
  return row;
}

/**
 * Insert an externally-resolved product unless another request won the same
 * UPC race. Unlike `createProduct`, this does not throw on a primary-key
 * conflict so the caller can reread the canonical cache row.
 */
export async function createResolvedProduct(
  db: Database,
  values: NewProduct,
): Promise<Product | undefined> {
  const [row] = await db
    .insert(schema.products)
    .values(values)
    .onConflictDoNothing()
    .returning();
  return row;
}

async function updateProduct(
  db: Database,
  upc: string,
  values: Partial<Omit<NewProduct, "upc">>,
): Promise<Product | undefined> {
  const [row] = await db
    .update(schema.products)
    .set({ ...values, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.products.upc, upc))
    .returning();
  return row;
}

/**
 * Point a product at its replacement image, then remove stale MIME variants
 * only after D1 has committed the new pointer.
 */
export async function updateProductWithImageCleanup(
  db: Database,
  env: Env,
  upc: string,
  values: Partial<Omit<NewProduct, "upc">>,
): Promise<Product | undefined> {
  const row = await updateProduct(db, upc, values);
  if (row && values.imageKey !== undefined) {
    await cleanupImageVariants(env, upc, row.imageKey);
  }
  return row;
}

/**
 * Delete a product and clean up its R2 image (avoids orphaned objects).
 * Returns true if a row was deleted.
 */
export async function deleteProduct(
  db: Database,
  env: Env,
  upc: string,
): Promise<boolean> {
  const existing = await getProduct(db, upc);
  if (!existing) return false;

  await db.delete(schema.products).where(eq(schema.products.upc, upc));

  await deleteImageVariants(env, upc);
  return true;
}

export type ListProductsOptions = {
  q?: string;
  source?: string;
  page?: number;
  pageSize?: number;
};

export type ListProductsResult = {
  rows: Product[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listProducts(
  db: Database,
  { q, source, page = 1, pageSize = 25 }: ListProductsOptions = {},
): Promise<ListProductsResult> {
  const safePage = Math.max(page, 1);
  const safePageSize = clamp(pageSize, 1, 100);

  const conditions = [];
  if (q && q.trim().length > 0) {
    const pattern = `%${q.trim()}%`;
    conditions.push(
      or(
        like(schema.products.name, pattern),
        like(schema.products.manufacturer, pattern),
        like(schema.products.brand, pattern),
      ),
    );
  }
  if (source) {
    conditions.push(eq(schema.products.source, source));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Page rows and total count are independent — one round trip.
  const [rows, countResult] = await Promise.all([
    db.query.products.findMany({
      where,
      orderBy: [desc(schema.products.createdAt)],
      limit: safePageSize,
      offset: (safePage - 1) * safePageSize,
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.products)
      .where(where),
  ]);
  const total = countResult[0]?.count ?? 0;

  return { rows, total, page: safePage, pageSize: safePageSize };
}

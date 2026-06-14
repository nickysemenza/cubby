import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Database } from "./index";
import { schema } from "./index";
import type { Env } from "../types";
import { deleteImage } from "../storage/images";
import { chunk } from "../util/chunk";
import type { Product, NewProduct } from "./schema";

// D1 caps bound parameters per statement; chunk IN-lists well under the limit.
const IN_CHUNK = 100;

/** Fields an admin/agent may set when creating or editing a product. */
export type ProductWriteInput = {
  name: string;
  manufacturer?: string | null;
  brand?: string | null;
  category?: string | null;
  description?: string | null;
  priceDollars?: number | null;
  imageKey?: string | null;
  source?: string;
  sourceData?: string | null;
};

/** Get a single product by UPC, or undefined if not found. */
export async function getProduct(
  db: Database,
  upc: string,
): Promise<Product | undefined> {
  return db.query.products.findFirst({
    where: eq(schema.products.upc, upc),
  });
}

/** Get all cached products for the given UPCs in one chunked IN query. */
export async function getProducts(
  db: Database,
  upcs: string[],
): Promise<Product[]> {
  if (upcs.length === 0) return [];
  const out: Product[] = [];
  for (const batch of chunk(upcs, IN_CHUNK)) {
    const rows = await db.query.products.findMany({
      where: inArray(schema.products.upc, batch),
    });
    out.push(...rows);
  }
  return out;
}

/** Insert a product row and return it. */
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
 * Update an existing product. Always stamps `updatedAt`. Returns the updated
 * row, or undefined if no product with that UPC exists.
 */
export async function updateProduct(
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

  if (existing.imageKey) {
    await deleteImage(env, existing.imageKey);
  }
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

/**
 * Paginated, filterable product listing for the admin UI and MCP.
 * `q` matches name/manufacturer/brand (case-insensitive substring).
 */
export async function listProducts(
  db: Database,
  { q, source, page = 1, pageSize = 25 }: ListProductsOptions = {},
): Promise<ListProductsResult> {
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);

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

  const rows = await db.query.products.findMany({
    where,
    orderBy: [desc(schema.products.createdAt)],
    limit: safePageSize,
    offset: (safePage - 1) * safePageSize,
  });

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.products)
    .where(where);
  const total = countResult[0]?.count ?? 0;

  return { rows, total, page: safePage, pageSize: safePageSize };
}

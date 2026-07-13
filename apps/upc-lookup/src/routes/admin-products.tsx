import { Hono } from "hono";
import { SOURCE_NAMES } from "../api/sources";
import { lookupExternalProduct } from "../api";
import {
  Card,
  Layout,
  SourceBadge,
  flashFromQuery,
  withFlash,
} from "../admin/layout";
import { createDb } from "../db";
import { deleteMiss } from "../db/misses";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from "../db/products";
import { getImageUrl, storeImage, storeImageBlob } from "../storage/images";
import type { Env } from "../types";
import { UPC_REGEX } from "../util/upc";
import {
  optionalString as str,
  parsePrice,
  ProductForm,
  readForm,
  uploadedFile as fileFrom,
} from "./admin-forms";
import { formatUSD, FormError } from "./admin-presentation";

const productRoutes = new Hono<{ Bindings: Env }>();
const admin = productRoutes;
const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------

admin.get("/products", async (c) => {
  const db = createDb(c.env.DB);
  const q = c.req.query("q") ?? "";
  const source = c.req.query("source") ?? "";
  const page = Number.parseInt(c.req.query("page") ?? "1", 10) || 1;
  const baseUrl = new URL(c.req.url).origin;

  const { rows, total, pageSize } = await listProducts(db, {
    q,
    source: source || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const hasPrev = page > 1;
  const hasNext = end < total;
  const qs = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (source) params.set("source", source);
    params.set("page", String(p));
    return `/admin/products?${params.toString()}`;
  };

  return c.render(
    <Layout
      title="Products"
      active="products"
      flash={flashFromQuery(c.req.query("flash"), c.req.query("flashType"))}
    >
      <form
        method="get"
        action="/admin/products"
        class="mb-4 flex flex-wrap gap-2"
      >
        <input
          type="search"
          name="q"
          value={q}
          placeholder="Search name, brand, manufacturer…"
          class="min-w-64 flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200"
        />
        <select
          name="source"
          class="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-200"
        >
          <option value="" selected={source === ""}>
            All sources
          </option>
          {SOURCE_NAMES.map((s) => (
            <option value={s} selected={source === s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="submit"
          class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Search
        </button>
        <a
          href="/admin/products/new"
          class="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          + New
        </a>
      </form>

      <p class="mb-3 text-sm text-zinc-500">
        {total === 0 ? "No products found" : `${start}–${end} of ${total}`}
      </p>

      <Card class="overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th class="p-3 font-medium">Image</th>
                <th class="p-3 font-medium">UPC</th>
                <th class="p-3 font-medium">Name</th>
                <th class="p-3 font-medium">Brand</th>
                <th class="p-3 font-medium">Category</th>
                <th class="p-3 font-medium">Price</th>
                <th class="p-3 font-medium">Source</th>
                <th class="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.upc}
                  class="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/80"
                >
                  <td class="p-3">
                    {p.imageKey ? (
                      <img
                        src={getImageUrl(p.imageKey, baseUrl)}
                        alt={p.name}
                        class="h-12 w-12 rounded-md object-contain"
                      />
                    ) : (
                      <span class="text-zinc-300">—</span>
                    )}
                  </td>
                  <td class="p-3 font-mono text-xs text-zinc-600">{p.upc}</td>
                  <td class="p-3 font-medium text-zinc-900">{p.name}</td>
                  <td class="p-3 text-zinc-600">{p.brand ?? "—"}</td>
                  <td class="p-3 text-zinc-600">{p.category ?? "—"}</td>
                  <td class="p-3 tabular-nums text-zinc-700">
                    {formatUSD(p.priceDollars)}
                  </td>
                  <td class="p-3">
                    <SourceBadge source={p.source} />
                  </td>
                  <td class="p-3">
                    <div class="flex items-center justify-end gap-1">
                      <a
                        href={`/admin/products/${p.upc}/edit`}
                        class="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
                      >
                        Edit
                      </a>
                      <form
                        method="post"
                        action={`/admin/products/${p.upc}/refetch`}
                      >
                        <button
                          type="submit"
                          class="rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
                        >
                          Re-fetch
                        </button>
                      </form>
                      <form
                        method="post"
                        action={`/admin/products/${p.upc}/delete`}
                        onsubmit="return confirm('Delete this product?')"
                      >
                        <button
                          type="submit"
                          class="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {(hasPrev || hasNext) && (
        <div class="mt-4 flex items-center justify-between text-sm">
          {hasPrev ? (
            <a
              href={qs(page - 1)}
              class="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50"
            >
              ← Previous
            </a>
          ) : (
            <span />
          )}
          {hasNext ? (
            <a
              href={qs(page + 1)}
              class="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Next →
            </a>
          ) : (
            <span />
          )}
        </div>
      )}
    </Layout>,
  );
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

admin.get("/products/new", (c) =>
  c.render(
    <Layout title="New product" active="new">
      <ProductForm action="/admin/products" submitLabel="Create product" />
    </Layout>,
  ),
);

admin.post("/products", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.parseBody();
  const upc = str(body.upc);
  const name = str(body.name);

  if (!upc || !UPC_REGEX.test(upc)) {
    return c.render(
      <Layout title="New product" active="new">
        <FormError message="Invalid UPC. Must be 8, 12, 13, or 14 digits." />
        <ProductForm
          action="/admin/products"
          submitLabel="Create product"
          values={{ ...readForm(body), upc: str(body.upc) ?? "" }}
        />
      </Layout>,
    );
  }
  if (!name) {
    return c.render(
      <Layout title="New product" active="new">
        <FormError message="Name is required." />
        <ProductForm
          action="/admin/products"
          submitLabel="Create product"
          values={{ ...readForm(body), upc }}
        />
      </Layout>,
    );
  }

  const existing = await getProduct(db, upc);
  if (existing) {
    return c.render(
      <Layout title="New product" active="new">
        <FormError message={`A product with UPC ${upc} already exists.`} />
        <ProductForm
          action="/admin/products"
          submitLabel="Create product"
          values={{ ...readForm(body), upc }}
        />
      </Layout>,
    );
  }

  const file = fileFrom(body.imageFile);
  const imageUrl = str(body.imageUrl);
  const imageKey = file
    ? await storeImageBlob(upc, file, c.env)
    : imageUrl
      ? await storeImage(upc, imageUrl, c.env)
      : null;

  await createProduct(db, {
    upc,
    name,
    manufacturer: str(body.manufacturer),
    brand: str(body.brand),
    category: str(body.category),
    description: str(body.description),
    priceDollars: parsePrice(body.priceDollars),
    imageKey,
    source: "manual",
    sourceData: null,
  });

  // The UPC now has data — drop it from the misses worklist if it was there.
  await deleteMiss(db, upc);

  return c.redirect(withFlash("/admin/products", `Created ${name}`));
});

// ---------------------------------------------------------------------------
// Edit / update
// ---------------------------------------------------------------------------

admin.get("/products/:upc/edit", async (c) => {
  const db = createDb(c.env.DB);
  const product = await getProduct(db, c.req.param("upc"));
  if (!product)
    return c.redirect(
      withFlash("/admin/products", "Product not found", "error"),
    );

  return c.render(
    <Layout title="Edit product" active="products">
      <ProductForm
        action={`/admin/products/${product.upc}`}
        submitLabel="Save changes"
        values={{
          upc: product.upc,
          name: product.name,
          manufacturer: product.manufacturer,
          brand: product.brand,
          category: product.category,
          description: product.description,
          priceDollars: product.priceDollars,
        }}
        upcReadOnly
        imageKey={product.imageKey}
        baseUrl={new URL(c.req.url).origin}
      />
    </Layout>,
  );
});

admin.post("/products/:upc", async (c) => {
  const db = createDb(c.env.DB);
  const upc = c.req.param("upc");
  const body = await c.req.parseBody();
  const name = str(body.name);

  const existing = await getProduct(db, upc);
  if (!existing)
    return c.redirect(
      withFlash("/admin/products", "Product not found", "error"),
    );
  if (!name) {
    return c.render(
      <Layout title="Edit product" active="products">
        <FormError message="Name is required." />
        <ProductForm
          action={`/admin/products/${upc}`}
          submitLabel="Save changes"
          values={{ ...readForm(body), upc }}
          upcReadOnly
          imageKey={existing.imageKey}
          baseUrl={new URL(c.req.url).origin}
        />
      </Layout>,
    );
  }

  const file = fileFrom(body.imageFile);
  const imageUrl = str(body.imageUrl);
  const imageKey = file
    ? ((await storeImageBlob(upc, file, c.env)) ?? existing.imageKey)
    : imageUrl
      ? ((await storeImage(upc, imageUrl, c.env)) ?? existing.imageKey)
      : existing.imageKey;

  await updateProduct(db, upc, {
    name,
    manufacturer: str(body.manufacturer),
    brand: str(body.brand),
    category: str(body.category),
    description: str(body.description),
    priceDollars: parsePrice(body.priceDollars),
    imageKey,
  });

  return c.redirect(withFlash("/admin/products", `Updated ${name}`));
});

// ---------------------------------------------------------------------------
// Re-fetch / delete
// ---------------------------------------------------------------------------

admin.post("/products/:upc/refetch", async (c) => {
  const db = createDb(c.env.DB);
  const upc = c.req.param("upc");

  const existing = await getProduct(db, upc);
  if (!existing)
    return c.redirect(
      withFlash("/admin/products", "Product not found", "error"),
    );

  const result = await lookupExternalProduct(upc);
  if (result.status !== "found") {
    const message =
      result.status === "error"
        ? `Lookup for ${upc} failed (rate limited or unavailable) — try again later`
        : `No source had data for ${upc}`;
    return c.redirect(withFlash("/admin/products", message, "error"));
  }
  const data = result.data;

  const imageKey = data.imageUrl
    ? ((await storeImage(upc, data.imageUrl, c.env)) ?? existing.imageKey)
    : existing.imageKey;

  await updateProduct(db, upc, {
    name: data.name,
    manufacturer: data.manufacturer,
    brand: data.brand,
    category: data.category,
    description: data.description,
    priceDollars: data.priceDollars,
    imageKey,
    source: data.source,
    sourceData: data.sourceData,
  });

  return c.redirect(
    withFlash("/admin/products", `Re-fetched ${data.name} from ${data.source}`),
  );
});

admin.post("/products/:upc/delete", async (c) => {
  const db = createDb(c.env.DB);
  const upc = c.req.param("upc");
  const deleted = await deleteProduct(db, c.env, upc);
  return c.redirect(
    withFlash(
      "/admin/products",
      deleted ? `Deleted ${upc}` : "Product not found",
      deleted ? "success" : "error",
    ),
  );
});

export { productRoutes };

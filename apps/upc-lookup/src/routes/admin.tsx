import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../types";
import { createDb } from "../db";
import {
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  listProducts,
} from "../db/products";
import { deleteMiss, listMisses } from "../db/misses";
import { getStats } from "./stats";
import { resolveProductOutcome } from "../services/products";
import { lookupExternalProduct } from "../api";
import { SOURCE_NAMES } from "../api/sources";
import { storeImage, storeImageBlob, getImageUrl } from "../storage/images";
import {
  Layout,
  Card,
  SourceBadge,
  flashFromQuery,
  withFlash,
} from "../admin/layout";

const admin = new Hono<{ Bindings: Env }>();

// UPC validation regex (8, 12, 13, or 14 digits) — matches routes/lookup.ts
const UPC_REGEX = /^\d{8}$|^\d{12,14}$/;
const PAGE_SIZE = 25;

function formatUSD(dollars: number | null): string {
  if (dollars === null) return "—";
  return `$${dollars.toFixed(2)}`;
}

/** Coerce an empty/whitespace form value to null. */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePrice(value: unknown): number | null {
  const s = str(value);
  if (s === null) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** A non-empty uploaded file from a multipart form, or null. */
function fileFrom(value: unknown): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

admin.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const stats = await getStats(db);
  return c.render(
    <Layout title="Dashboard">
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Products" value={stats.totalProducts} />
        <StatCard label="Images" value={stats.storageUsed.r2Objects} />
        {Object.entries(stats.bySource).map(([source, count]) => (
          <StatCard label={source} value={count} />
        ))}
      </div>
      <div class="mt-6 flex gap-3">
        <a
          href="/admin/products"
          class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Browse products
        </a>
        <a
          href="/admin/products/new"
          class="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          New product
        </a>
      </div>
    </Layout>,
  );
});

// ---------------------------------------------------------------------------
// Product list (search + pagination)
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

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

admin.get("/stats", async (c) => {
  const db = createDb(c.env.DB);
  const stats = await getStats(db);
  return c.render(
    <Layout title="Cache statistics" active="stats">
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Total products" value={stats.totalProducts} />
        <StatCard label="D1 rows" value={stats.storageUsed.d1Rows} />
        <StatCard label="R2 images" value={stats.storageUsed.r2Objects} />
      </div>
      <h2 class="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        By source
      </h2>
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Object.entries(stats.bySource).map(([source, count]) => (
          <StatCard label={source} value={count} />
        ))}
      </div>
    </Layout>,
  );
});

// ---------------------------------------------------------------------------
// Misses (worklist of UPCs no source had data for)
// ---------------------------------------------------------------------------

admin.get("/misses", async (c) => {
  const db = createDb(c.env.DB);
  const q = c.req.query("q") ?? "";
  const page = Number.parseInt(c.req.query("page") ?? "1", 10) || 1;

  const { rows, total, pageSize } = await listMisses(db, {
    q,
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
    params.set("page", String(p));
    return `/admin/misses?${params.toString()}`;
  };

  return c.render(
    <Layout
      title="Misses"
      active="misses"
      flash={flashFromQuery(c.req.query("flash"), c.req.query("flashType"))}
    >
      <p class="mb-4 max-w-2xl text-sm text-zinc-500">
        UPCs that were looked up but no source had data. Each was tried against
        the external API once. Create a product to fill one in — it then drops
        off this list and becomes a cache hit.
      </p>
      <form
        method="get"
        action="/admin/misses"
        class="mb-4 flex flex-wrap gap-2"
      >
        <input
          type="search"
          name="q"
          value={q}
          placeholder="Search UPC…"
          class="min-w-64 flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200"
        />
        <button
          type="submit"
          class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      <p class="mb-3 text-sm text-zinc-500">
        {total === 0 ? "No misses 🎉" : `${start}–${end} of ${total}`}
      </p>

      <Card class="overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th class="p-3 font-medium">UPC</th>
                <th class="p-3 font-medium">Attempts</th>
                <th class="p-3 font-medium">Last checked</th>
                <th class="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr
                  key={m.upc}
                  class="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/80"
                >
                  <td class="p-3 font-mono text-xs text-zinc-600">{m.upc}</td>
                  <td class="p-3 tabular-nums text-zinc-700">{m.attempts}</td>
                  <td class="p-3 text-zinc-500">{m.lastCheckedAt ?? "—"}</td>
                  <td class="p-3">
                    <div class="flex items-center justify-end gap-1">
                      <a
                        href={`/admin/misses/${m.upc}/create`}
                        class="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
                      >
                        Create product
                      </a>
                      <form
                        method="post"
                        action={`/admin/misses/${m.upc}/refetch`}
                      >
                        <button
                          type="submit"
                          class="rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
                        >
                          Re-try
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

// Pre-fill the create form with a miss's UPC (reuses POST /admin/products,
// which deletes the miss row on success).
admin.get("/misses/:upc/create", (c) =>
  c.render(
    <Layout title="Create product from miss" active="misses">
      <ProductForm
        action="/admin/products"
        submitLabel="Create product"
        values={{ upc: c.req.param("upc") }}
      />
    </Layout>,
  ),
);

// Try the external API once more for a miss (covers transient earlier
// failures). On success the UPC graduates to a product and leaves the list.
admin.post("/misses/:upc/refetch", async (c) => {
  const db = createDb(c.env.DB);
  const upc = c.req.param("upc");

  // force: bypass the miss-cache TTL guard so an explicit "Re-try" actually
  // re-hits the external API (every worklist entry is a recent miss).
  const outcome = await resolveProductOutcome(db, c.env, upc, { force: true });
  const { message, type } =
    outcome.status === "found"
      ? {
          message: `Found data for ${upc} — added as a product`,
          type: "success" as const,
        }
      : outcome.status === "error"
        ? {
            message: `Lookup for ${upc} failed (rate limited or unavailable) — try again later`,
            type: "error" as const,
          }
        : { message: `Still no data for ${upc}`, type: "error" as const };

  return c.redirect(withFlash("/admin/misses", message, type));
});

export { admin };

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const StatCard: FC<{ label: string; value: number }> = ({ label, value }) => (
  <Card class="p-4">
    <div class="text-2xl font-bold tabular-nums text-zinc-900">{value}</div>
    <div class="mt-1 truncate text-xs uppercase tracking-wide text-zinc-500">
      {label}
    </div>
  </Card>
);

const FormError: FC<{ message: string }> = ({ message }) => (
  <div class="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
    {message}
  </div>
);

type FormValues = {
  upc?: string;
  name?: string | null;
  manufacturer?: string | null;
  brand?: string | null;
  category?: string | null;
  description?: string | null;
  priceDollars?: number | null;
};

/** Pull editable fields back out of a submitted body for error re-rendering. */
function readForm(body: Record<string, unknown>): FormValues {
  return {
    name: str(body.name),
    manufacturer: str(body.manufacturer),
    brand: str(body.brand),
    category: str(body.category),
    description: str(body.description),
    priceDollars: parsePrice(body.priceDollars),
  };
}

const ProductForm: FC<{
  action: string;
  submitLabel: string;
  values?: FormValues;
  upcReadOnly?: boolean;
  imageKey?: string | null;
  baseUrl?: string;
}> = ({ action, submitLabel, values = {}, upcReadOnly, imageKey, baseUrl }) => (
  <Card class="max-w-2xl p-6">
    <form
      method="post"
      action={action}
      enctype="multipart/form-data"
      class="grid gap-4"
    >
      <Field label="UPC">
        <input
          name="upc"
          value={values.upc ?? ""}
          required={!upcReadOnly}
          readonly={upcReadOnly}
          placeholder="012345678901"
          class={inputClass(upcReadOnly)}
        />
      </Field>
      <Field label="Name">
        <input
          name="name"
          value={values.name ?? ""}
          required
          class={inputClass()}
        />
      </Field>
      <div class="grid grid-cols-2 gap-4">
        <Field label="Brand">
          <input name="brand" value={values.brand ?? ""} class={inputClass()} />
        </Field>
        <Field label="Manufacturer">
          <input
            name="manufacturer"
            value={values.manufacturer ?? ""}
            class={inputClass()}
          />
        </Field>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <Field label="Category">
          <input
            name="category"
            value={values.category ?? ""}
            class={inputClass()}
          />
        </Field>
        <Field label="Price (USD)">
          <input
            name="priceDollars"
            type="number"
            step="0.01"
            min="0"
            value={values.priceDollars ?? ""}
            class={inputClass()}
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea name="description" rows={3} class={inputClass()}>
          {values.description ?? ""}
        </textarea>
      </Field>
      <ImageField imageKey={imageKey} baseUrl={baseUrl} />
      <div class="flex items-center gap-3 pt-2">
        <button
          type="submit"
          class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          {submitLabel}
        </button>
        <a
          href="/admin/products"
          class="rounded-lg px-4 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-900"
        >
          Cancel
        </a>
      </div>
    </form>
  </Card>
);

const Field: FC<{ label: string; children?: import("hono/jsx").Child }> = ({
  label,
  children,
}) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
  <label class="block">
    <span class="mb-1 block text-sm font-medium text-zinc-700">{label}</span>
    {children}
  </label>
);

function inputClass(readOnly?: boolean): string {
  const base =
    "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200";
  return readOnly ? `${base} bg-zinc-100 text-zinc-500` : base;
}

/**
 * Image input supporting drag & drop, clipboard paste, and click-to-browse
 * (file uploaded via multipart), plus an image-URL fallback. The submitted
 * file takes precedence over the URL server-side.
 */
const ImageField: FC<{ imageKey?: string | null; baseUrl?: string }> = ({
  imageKey,
  baseUrl,
}) => (
  <div class="block">
    <span class="mb-1 block text-sm font-medium text-zinc-700">Image</span>
    <label
      id="imageDropzone"
      class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 transition hover:border-zinc-400 hover:bg-zinc-100"
    >
      <span>
        Drag &amp; drop an image, paste from clipboard, or click to browse
      </span>
      <input
        id="imageFile"
        name="imageFile"
        type="file"
        accept="image/*"
        class="sr-only"
      />
      <img
        id="imagePreview"
        alt="upload preview"
        class="mt-2 hidden h-24 w-24 rounded-md object-contain"
      />
    </label>
    {imageKey && baseUrl && (
      <div class="mt-2 flex items-center gap-2 text-xs text-zinc-500">
        <img
          src={getImageUrl(imageKey, baseUrl)}
          alt="current"
          class="h-12 w-12 rounded-md object-contain"
        />
        <span>Current image (replaced if you add a new one)</span>
      </div>
    )}
    <input
      name="imageUrl"
      type="url"
      placeholder="…or paste an image URL"
      class={`${inputClass()} mt-2`}
    />
    <script dangerouslySetInnerHTML={{ __html: IMAGE_SCRIPT }} />
  </div>
);

// Progressive enhancement: wire drag/drop + paste to the hidden file input and
// show a live preview. Plain string (no user input) injected as an inline script.
const IMAGE_SCRIPT = `
(function () {
  var input = document.getElementById('imageFile');
  var zone = document.getElementById('imageDropzone');
  var preview = document.getElementById('imagePreview');
  if (!input || !zone || !preview) return;
  function show(file) {
    if (!file) return;
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
  }
  function assign(file) {
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch (e) {}
    show(file);
  }
  input.addEventListener('change', function () {
    if (input.files && input.files[0]) show(input.files[0]);
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) {
      e.preventDefault();
      zone.classList.add('border-zinc-500', 'bg-zinc-100');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) {
      e.preventDefault();
      zone.classList.remove('border-zinc-500', 'bg-zinc-100');
    });
  });
  zone.addEventListener('drop', function (e) {
    var files = (e.dataTransfer && e.dataTransfer.files) || [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].type.indexOf('image/') === 0) { assign(files[i]); break; }
    }
  });
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) { assign(f); e.preventDefault(); }
        break;
      }
    }
  });
})();
`;

import { Hono } from "hono";
import { Layout } from "../admin/layout";
import { createDb } from "../db";
import type { Env } from "../types";
import { StatCard } from "./admin-presentation";
import { getStats } from "./stats";

const dashboardRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------

dashboardRoutes.get("/", async (c) => {
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

dashboardRoutes.get("/stats", async (c) => {
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

export { dashboardRoutes };

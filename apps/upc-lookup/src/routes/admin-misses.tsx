import { Hono } from "hono";
import { Card, Layout, flashFromQuery, withFlash } from "../admin/layout";
import { createDb } from "../db";
import { listMisses } from "../db/misses";
import { resolveProductOutcome } from "../services/products";
import type { Env } from "../types";
import { ProductForm } from "./admin-forms";

const missRoutes = new Hono<{ Bindings: Env }>();
const admin = missRoutes;
const PAGE_SIZE = 25;

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
                  <td class="p-3" aria-label="Actions">
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

export { missRoutes };

import { Hono } from "hono";
import { cors } from "hono/cors";
import { setCookie, deleteCookie } from "hono/cookie";
import { apiReference } from "@scalar/hono-api-reference";
import type { Env } from "./types";
import { apiKeyAuth, adminAuth, ADMIN_COOKIE_NAME } from "./middleware/auth";
import { lookup } from "./routes/lookup";
import { search } from "./routes/search";
import { stats, getStats } from "./routes/stats";
import { renderer } from "./renderer";
import { createDb, schema } from "./db";
import { getImageUrl } from "./storage/images";
import { desc, eq } from "drizzle-orm";
import { openApiDocument } from "./openapi";

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for API routes
app.use("/lookup/*", cors());
app.use("/search", cors());
app.use("/stats", cors());

// API routes (protected with API key)
app.use("/lookup/*", apiKeyAuth);
app.use("/search", apiKeyAuth);
app.use("/stats", apiKeyAuth);

app.route("/lookup", lookup);
app.route("/search", search);
app.route("/stats", stats);

// Health check (no auth required)
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Serve images from R2 (no auth required for images)
app.get("/images/:filename", async (c) => {
  const filename = c.req.param("filename");
  const key = `images/${filename}`;

  const object = await c.env.IMAGES.get(key);
  if (!object) {
    return c.notFound();
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
});

// Admin login page (no auth required)
app.use("/admin/login", renderer);

app.get("/admin/login", (c) => {
  const error = c.req.query("error");
  return c.render(
    <div class="max-w-md mx-auto mt-24 p-6">
      <h1 class="text-2xl font-bold mb-6">Admin Login</h1>
      {error && (
        <p class="text-red-700 bg-red-100 p-3 rounded mb-4">
          Invalid API key
        </p>
      )}
      <form method="post" action="/admin/login">
        <div class="mb-4">
          <label class="block mb-1 font-medium">API Key</label>
          <input
            type="password"
            name="apiKey"
            required
            class="w-full p-2 text-base border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          class="w-full p-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer"
        >
          Login
        </button>
      </form>
    </div>
  );
});

app.post("/admin/login", async (c) => {
  const body = await c.req.parseBody();
  const apiKey = body.apiKey as string;

  if (apiKey !== c.env.API_KEY) {
    return c.redirect("/admin/login?error=1");
  }

  // Set session cookie
  setCookie(c, ADMIN_COOKIE_NAME, apiKey, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });

  return c.redirect("/admin");
});

app.get("/admin/logout", (c) => {
  deleteCookie(c, ADMIN_COOKIE_NAME, { path: "/" });
  return c.redirect("/admin/login");
});

// Admin UI routes (protected with cookie auth)
app.use("/admin/*", adminAuth);
app.use("/admin/*", renderer);

app.get("/admin", async (c) => {
  return c.render(
    <div class="p-6">
      <h1 class="text-2xl font-bold mb-4">UPC Lookup Admin</h1>
      <nav class="flex gap-4">
        <a href="/admin/products" class="text-blue-600 hover:underline">Browse Products</a>
        <a href="/admin/stats" class="text-blue-600 hover:underline">View Stats</a>
        <a href="/admin/logout" class="text-red-600 hover:underline">Logout</a>
      </nav>
    </div>
  );
});

// Format dollars as USD
function formatUSD(dollars: number | null): string {
  if (dollars === null) return "-";
  return `$${dollars.toFixed(2)}`;
}

// Delete product endpoint
app.post("/admin/products/:upc/delete", async (c) => {
  const upc = c.req.param("upc");
  const db = createDb(c.env.DB);

  // Delete the product
  await db.delete(schema.products).where(eq(schema.products.upc, upc));

  // Redirect back to products list
  return c.redirect("/admin/products");
});

app.get("/admin/products", async (c) => {
  const db = createDb(c.env.DB);
  const products = await db.query.products.findMany({
    orderBy: [desc(schema.products.createdAt)],
    limit: 100,
  });

  return c.render(
    <div class="p-6">
      <h1 class="text-2xl font-bold mb-2">Product Browser</h1>
      <p class="text-gray-600 mb-4">Showing {products.length} most recent products</p>
      <div class="overflow-x-auto">
        <table class="w-full border-collapse">
          <thead>
            <tr class="border-b-2 border-gray-300">
              <th class="p-2 text-left whitespace-nowrap">Image</th>
              <th class="p-2 text-left whitespace-nowrap">UPC</th>
              <th class="p-2 text-left whitespace-nowrap">Name</th>
              <th class="p-2 text-left whitespace-nowrap">Brand</th>
              <th class="p-2 text-left whitespace-nowrap">Manufacturer</th>
              <th class="p-2 text-left whitespace-nowrap">Category</th>
              <th class="p-2 text-left whitespace-nowrap">Price</th>
              <th class="p-2 text-left whitespace-nowrap">Source</th>
              <th class="p-2 text-left whitespace-nowrap">Description</th>
              <th class="p-2 text-left whitespace-nowrap">Raw Data</th>
              <th class="p-2 text-left whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.upc} class="border-b border-gray-200 hover:bg-gray-50">
                <td class="p-2 align-top">
                  {p.imageKey ? (
                    <img
                      src={getImageUrl(p.imageKey)}
                      alt={p.name}
                      class="w-20 h-20 object-contain"
                    />
                  ) : (
                    <span class="text-gray-400">-</span>
                  )}
                </td>
                <td class="p-2 align-top font-mono text-sm">{p.upc}</td>
                <td class="p-2 align-top">{p.name}</td>
                <td class="p-2 align-top">{p.brand || <span class="text-gray-400">-</span>}</td>
                <td class="p-2 align-top">{p.manufacturer || <span class="text-gray-400">-</span>}</td>
                <td class="p-2 align-top">{p.category || <span class="text-gray-400">-</span>}</td>
                <td class="p-2 align-top">{formatUSD(p.priceDollars)}</td>
                <td class="p-2 align-top">{p.source}</td>
                <td class="p-2 align-top max-w-xs truncate">
                  {p.description || <span class="text-gray-400">-</span>}
                </td>
                <td class="p-2 align-top">
                  {p.sourceData ? (
                    <details>
                      <summary class="cursor-pointer text-blue-600 hover:underline text-sm">View JSON</summary>
                      <pre class="text-xs max-w-md overflow-auto bg-gray-100 p-2 rounded mt-1">
                        {JSON.stringify(JSON.parse(p.sourceData), null, 2)}
                      </pre>
                    </details>
                  ) : (
                    <span class="text-gray-400">-</span>
                  )}
                </td>
                <td class="p-2 align-top">
                  <form method="post" action={`/admin/products/${p.upc}/delete`}>
                    <button
                      type="submit"
                      class="px-2 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 cursor-pointer"
                      onclick="return confirm('Delete this product?')"
                    >
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="mt-4">
        <a href="/admin" class="text-blue-600 hover:underline">Back to Admin</a>
      </p>
    </div>
  );
});

app.get("/admin/stats", async (c) => {
  const db = createDb(c.env.DB);
  const statsData = await getStats(db);

  return c.render(
    <div class="p-6">
      <h1 class="text-2xl font-bold mb-4">Cache Statistics</h1>
      <pre class="bg-gray-100 p-4 rounded overflow-auto text-sm">{JSON.stringify(statsData, null, 2)}</pre>
      <p class="mt-4">
        <a href="/admin" class="text-blue-600 hover:underline">Back to Admin</a>
      </p>
    </div>
  );
});

// OpenAPI JSON endpoint
app.get("/openapi.json", (c) => {
  return c.json(openApiDocument);
});

// Scalar API documentation at root
app.get(
  "/",
  apiReference({
    content: openApiDocument,
    theme: "default",
    layout: "modern",
    darkMode: true,
  })
);

export default app;

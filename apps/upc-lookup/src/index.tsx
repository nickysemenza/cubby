import * as Sentry from "@sentry/cloudflare";
import {
  CUBBY_SENTRY_DSN,
  registerSentryErrorCapture,
} from "@cubby/worker-tracing";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { setCookie, deleteCookie } from "hono/cookie";
import { apiReference } from "@scalar/hono-api-reference";
import type { Env } from "./types";
import {
  apiKeyAuth,
  adminAuth,
  mcpAuth,
  ADMIN_COOKIE_NAME,
  secretsMatch,
} from "./middleware/auth";
import { lookup } from "./routes/lookup";
import { search } from "./routes/search";
import { stats } from "./routes/stats";
import { admin } from "./routes/admin";
import { renderer } from "./renderer";
import { openApiDocument } from "./openapi";
import { z } from "zod";

const app = new Hono<{ Bindings: Env }>();

// Hono catches route throws and returns a 500 without rethrowing, so
// `Sentry.withSentry`'s throw-only auto-capture below never sees them.
registerSentryErrorCapture(app, Sentry.captureException);

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

// MCP endpoint — full agent parity with the admin UI (lookup/search/CRUD/stats).
// Stateless: a fresh server + transport per request (the SDK's connect() is
// single-use). Auth accepts X-API-Key or Authorization: Bearer.
app.all("/mcp", mcpAuth, async (c) => {
  // Imported here rather than at module scope. The MCP SDK pulls ajv,
  // ajv-formats, zod-to-json-schema and fast-uri — ~440 KiB, roughly a third
  // of this worker — to serve one route. Static imports put all of it on the
  // startup path of every /lookup, /search and /images request too.
  const [{ WebStandardStreamableHTTPServerTransport }, { createMcpServer }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
      import("./mcp/server"),
    ]);

  const baseUrl = new URL(c.req.url).origin;
  const server = createMcpServer(c.env, baseUrl);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
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
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(object.body, { headers });
});

// Admin login page (no auth required)
app.use("/admin/login", renderer);

app.get("/admin/login", (c) => {
  const error = c.req.query("error");
  return c.render(
    <div class="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div class="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 class="text-xl font-bold tracking-tight text-zinc-900">
          UPC Lookup
        </h1>
        <p class="mb-6 mt-1 text-sm text-zinc-500">Admin sign in</p>
        {error && (
          <div class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Invalid API key
          </div>
        )}
        <form method="post" action="/admin/login" class="grid gap-4">
          <label class="block">
            <span class="mb-1 block text-sm font-medium text-zinc-700">
              API Key
            </span>
            <input
              id="apiKey"
              type="password"
              name="apiKey"
              required
              autofocus
              class="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200"
            />
          </label>
          <button
            type="submit"
            class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Sign in
          </button>
        </form>
      </div>
    </div>,
  );
});

app.post("/admin/login", async (c) => {
  const body = await c.req.parseBody();
  const parsedApiKey = z.string().safeParse(body.apiKey);
  const apiKey = parsedApiKey.success ? parsedApiKey.data : "";

  if (!(await secretsMatch(apiKey, c.env.API_KEY))) {
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

// Admin UI routes (protected with cookie auth, rendered through the layout)
app.use("/admin", adminAuth);
app.use("/admin", renderer);
app.use("/admin/*", adminAuth);
app.use("/admin/*", renderer);
app.route("/admin", admin);

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
  }),
);

// Error capture into the shared `cubby` Sentry project, tagged `service:upc-lookup`
// so this worker's exceptions surface at their source instead of as opaque
// failures on the web side. `@cubby/worker-tracing` (OTel) keeps owning spans,
// so tracesSampleRate is 0. `withSentry`'s auto-capture only fires on a throw
// that escapes `fetch`; the `registerSentryErrorCapture` call above is what
// actually reports the route-level errors Hono swallows into a 500.
const handler = { fetch: app.fetch } satisfies ExportedHandler<Env>;

export default Sentry.withSentry(
  () => ({
    dsn: CUBBY_SENTRY_DSN,
    environment: import.meta.env.DEV ? "development" : "production",
    tracesSampleRate: 0,
    initialScope: { tags: { service: "upc-lookup" } },
  }),
  handler,
);

// Nx's supported HTTP contract: GET /v1/cache/{hash} -> 200|404,
// PUT -> 200|409. Authenticated immutable objects certify passing task results.
// CI also publishes its merged HTML test reports here: PUT /v1/reports/{key}
// requires the cache credential, and GET /reports/{key} serves them publicly.
// CI runs only synthetic data and test credentials, so reports are public.
interface Env {
  CACHE: R2Bucket;
  CACHE_TOKEN: string;
  EVENTS: AnalyticsEngineDataset;
  ANALYTICS_SQL: AnalyticsSQLBinding;
  ASSETS: Fetcher;
}

const encoder = new TextEncoder();
const outcomes = new Set(["hit", "miss", "stored", "exists", "error"]);
function authorized(request: Request, token: string): boolean {
  const supplied = encoder.encode(request.headers.get("authorization") ?? "");
  const expected = encoder.encode(`Bearer ${token}`);
  return (
    !!token &&
    supplied.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(supplied, expected)
  );
}

function record(
  env: Env,
  method: string,
  outcome: string,
  bytes: number,
  start: number,
) {
  // No keys, credentials, URLs, IPs or archive contents enter the public dataset.
  // Observability must never change the cache result or consume its body stream.
  try {
    env.EVENTS.writeDataPoint({
      indexes: ["cache-v1"],
      blobs: [outcome, method],
      doubles: [bytes, performance.now() - start],
    });
  } catch (error) {
    console.error("Cache telemetry:", error);
  }
}

async function stats(env: Env) {
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [activity, storage] = await Promise.allSettled([
    // Analytics SQL applies adaptive sample weights to COUNT/SUM/AVG itself.
    env.ANALYTICS_SQL.query({
      query: `SELECT toStartOfHour(timestamp) AS hour,
      blob1 AS outcome, blob2 AS method, COUNT(*) AS requests, SUM(double1) AS bytes,
      AVG(double2) AS latency
      FROM events.analyticsEngine.cubby_nx_cache
      WHERE timestamp >= $start AND index1 = 'cache-v1'
      GROUP BY hour, outcome, method ORDER BY hour DESC LIMIT 250`,
      params: { start },
    }),
    // Storage observations are state, not additive events: keep hourly maxima.
    env.ANALYTICS_SQL.query({
      query: `SELECT toStartOfHour(usageReportTimestamp) AS hour,
      MAX(objectCount) AS objects, MAX(payloadSizeBytes) AS bytes
      FROM states.r2CombinedStorage
      WHERE usageReportTimestamp >= $start AND bucketName = 'cubby-nx-cache'
      GROUP BY hour ORDER BY hour DESC LIMIT 25`,
      params: { start },
    }),
  ]);
  const number = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0)
      throw new Error("Invalid analytics aggregate");
    return n;
  };
  // Project only the public aggregates, even if the upstream adds other fields.
  const activityResult =
    activity.status === "fulfilled"
      ? {
          data: activity.value.data
            .filter(
              (row) =>
                outcomes.has(String(row.outcome)) &&
                ["GET", "PUT"].includes(String(row.method)),
            )
            .map((row) => ({
              hour: String(row.hour),
              outcome: String(row.outcome),
              method: String(row.method),
              requests: number(row.requests),
              bytes: number(row.bytes),
              latency: number(row.latency),
            })),
        }
      : { error: String(activity.reason) };
  const storageResult =
    storage.status === "fulfilled"
      ? {
          data: storage.value.data.map((row) => ({
            hour: String(row.hour),
            objects: number(row.objects),
            bytes: number(row.bytes),
          })),
        }
      : { error: String(storage.reason) };
  return {
    generatedAt: new Date().toISOString(),
    hours: 24,
    activity: activityResult,
    storage: storageResult,
  };
}

// {run}/{attempt}/{vitest|playwright}/{file path}; the bucket's 30-day expiry
// retires reports with cache entries. No segment may be empty or a dot path.
const reportKey =
  /^(\d+\/\d+\/(?:vitest|playwright))((?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*)$/;
const reportTypes = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
  ["ico", "image/x-icon"],
  ["webm", "video/webm"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["webmanifest", "application/manifest+json"],
  ["zip", "application/zip"],
  ["gz", "application/gzip"],
  ["txt", "text/plain; charset=utf-8"],
  ["md", "text/plain; charset=utf-8"],
]);

async function report(
  request: Request,
  env: Env,
  key: string,
  write: boolean,
): Promise<Response> {
  const root = key.endsWith("/");
  const match = reportKey.exec(root ? key.slice(0, -1) : key);
  if (!match) return new Response("not found", { status: 404 });
  // A report root serves its index. The root needs a trailing slash so the
  // reports' relative asset paths resolve inside it.
  if (!write && !match[2] && !root) {
    const location = new URL(request.url);
    location.pathname += "/";
    return Response.redirect(location.href, 308);
  }
  const objectKey = `reports/${match[1]}${match[2] || "/index.html"}`;
  if (write) {
    if (!authorized(request, env.CACHE_TOKEN))
      return new Response("unauthorized", { status: 401 });
    if (request.method !== "PUT")
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "PUT" },
      });
    if (!request.body) return new Response("missing body", { status: 400 });
    // Reruns publish under their own attempt, so a key is written once.
    await env.CACHE.put(objectKey, request.body);
    return new Response("stored");
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  let body: ReadableStream | null = null;
  if (request.method === "HEAD") {
    if (!(await env.CACHE.head(objectKey)))
      return new Response("not found", { status: 404 });
  } else {
    const object = await env.CACHE.get(objectKey);
    if (!object) return new Response("not found", { status: 404 });
    body = object.body;
  }
  const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1);
  return new Response(body, {
    headers: {
      "content-type":
        reportTypes.get(extension.toLowerCase()) ?? "application/octet-stream",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      // The bundled trace viewer fetches same-origin; this lets
      // trace.playwright.dev open a pasted trace URL.
      "access-control-allow-origin": "*",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/reports/"))
      return report(request, env, path.slice("/reports/".length), false);
    if (path.startsWith("/v1/reports/"))
      return report(request, env, path.slice("/v1/reports/".length), true);
    if (["/", "/dashboard.js", "/styles.css"].includes(path)) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("method not allowed", { status: 405 });
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      response.headers.set("x-content-type-options", "nosniff");
      return response;
    }
    if (path === "/stats.json") {
      if (request.method !== "GET")
        return new Response("method not allowed", { status: 405 });
      // One fixed time window/query set. Query strings never control SQL or bust
      // this edge cache; public page views should not each query analytics.
      const cacheKey = new Request(`${new URL(request.url).origin}/stats.json`);
      const cache = typeof caches === "undefined" ? undefined : caches.default;
      const cached = await cache?.match(cacheKey);
      if (cached) return cached;
      try {
        const snapshot = await stats(env);
        const healthy =
          "data" in snapshot.activity && "data" in snapshot.storage;
        const response = Response.json(snapshot, {
          headers: {
            "cache-control": healthy
              ? "public, max-age=60"
              : "public, max-age=10",
            "x-content-type-options": "nosniff",
          },
        });
        try {
          await cache?.put(cacheKey, response.clone());
        } catch (error) {
          console.error("Stats cache:", error);
        }
        return response;
      } catch (error) {
        return Response.json(
          { error: String(error) },
          { status: 502, headers: { "cache-control": "no-store" } },
        );
      }
    }
    if (path === "/healthz") {
      if (!authorized(request, env.CACHE_TOKEN))
        return new Response("unauthorized", { status: 401 });
      return request.method === "GET"
        ? new Response(null, {
            status: 204,
            headers: { "cache-control": "no-store" },
          })
        : new Response("method not allowed", {
            status: 405,
            headers: { allow: "GET" },
          });
    }
    const hash = /^\/v1\/cache\/([A-Za-z0-9]+)$/.exec(path)?.[1];
    if (!hash) return new Response("not found", { status: 404 });
    if (!authorized(request, env.CACHE_TOKEN))
      return new Response("unauthorized", { status: 401 });
    const start = performance.now();
    try {
      if (request.method === "GET") {
        const object = await env.CACHE.get(hash);
        record(env, "GET", object ? "hit" : "miss", object?.size ?? 0, start);
        if (!object) return new Response("not found", { status: 404 });
        return new Response(object.body, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
          },
        });
      }
      if (request.method === "PUT") {
        if (!request.body) return new Response("missing body", { status: 400 });
        const stored = await env.CACHE.put(hash, request.body, {
          onlyIf: { etagDoesNotMatch: "*" },
        });
        record(
          env,
          "PUT",
          stored ? "stored" : "exists",
          stored?.size ?? 0,
          start,
        );
        return stored
          ? new Response("stored")
          : new Response("exists", { status: 409 });
      }
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, PUT" },
      });
    } catch (error) {
      record(env, request.method, "error", 0, start);
      return new Response(String(error), {
        status: 500,
        headers: { "cache-control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<Env>;

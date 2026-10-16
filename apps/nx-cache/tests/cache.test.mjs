import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.ts";

// Workers extends SubtleCrypto; use Node's native constant-time equivalent.
Object.assign(crypto.subtle, { timingSafeEqual });

function setup() {
  const objects = new Map();
  const events = [];
  let reads = 0;
  const env = {
    CACHE_TOKEN: "synthetic-cache-token",
    CACHE: {
      async get(key) {
        reads++;
        const body = objects.get(key);
        return body === undefined ? null : { body, size: body.length };
      },
      async put(key, body) {
        if (objects.has(key)) return null;
        const value = await new Response(body).text();
        // Conditional R2 writes arbitrate concurrent publishers atomically.
        if (objects.has(key)) return null;
        objects.set(key, value);
        return { size: value.length };
      },
    },
    EVENTS: { writeDataPoint: (event) => events.push(event) },
    ANALYTICS_SQL: {
      async query({ query }) {
        return {
          data: query.includes("states.r2CombinedStorage")
            ? [{ hour: "2026-10-01 12:00:00", objects: 25, bytes: 8192 }]
            : [
                {
                  hour: "2026-10-01 12:00:00",
                  outcome: "hit",
                  method: "GET",
                  requests: 2,
                  bytes: 512,
                  latency: 12,
                },
              ],
        };
      },
    },
    ASSETS: { fetch: async () => new Response("synthetic dashboard") },
  };
  const request = (path, method = "GET", body) =>
    worker.fetch(
      new Request(`https://cache.example${path}`, {
        method,
        ...(method === "PUT" ? { body } : {}),
        headers: { authorization: `Bearer ${env.CACHE_TOKEN}` },
      }),
      env,
    );
  return { env, request, events, objects, reads: () => reads };
}

test("health verifies credentials without storage reads or cache-miss telemetry", async () => {
  const { env, request, events, reads } = setup();
  assert.equal((await request("/healthz")).status, 204);
  assert.equal(reads(), 0);
  assert.equal(events.length, 0);
  assert.equal((await request("/v1/cache/0")).status, 404);
  assert.equal(events.length, 0);
  assert.equal(
    (await worker.fetch(new Request("https://cache.example/healthz"), env))
      .status,
    401,
  );
});

test("public dashboard and aggregate stats do not grant artifact access", async () => {
  const { env } = setup();
  for (const path of ["/", "/stats.json"]) {
    const response = await worker.fetch(
      new Request(`https://cache.example${path}`),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(env.CACHE_TOKEN), false);
  }
  assert.equal(
    (await worker.fetch(new Request("https://cache.example/v1/cache/abc"), env))
      .status,
    401,
  );
});

test("immutable publishers report hits, misses, stored bytes and conflicts", async () => {
  const { request, events } = setup();
  assert.equal((await request("/v1/cache/abc")).status, 404);
  const writes = await Promise.all([
    request("/v1/cache/abc", "PUT", "archive"),
    request("/v1/cache/abc", "PUT", "other"),
  ]);
  assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
  const hit = await request("/v1/cache/abc");
  assert.equal(await hit.text(), "archive");
  assert.deepEqual(events.map((e) => e.blobs[0]).sort(), [
    "exists",
    "hit",
    "miss",
    "stored",
  ]);
  assert.equal(events.find((e) => e.blobs[0] === "hit").doubles[0], 7);
  assert.equal(JSON.stringify(events).includes("abc"), false);
});

test("telemetry outages cannot turn successful reads or writes into failures", async () => {
  const { env, request } = setup();
  env.EVENTS.writeDataPoint = () => {
    throw new Error("synthetic telemetry failure");
  };
  assert.equal((await request("/v1/cache/abc", "PUT", "archive")).status, 200);
  assert.equal(await (await request("/v1/cache/abc")).text(), "archive");
});

test("storage errors stay failures and are observable without artifact identity", async () => {
  const { env, request, events } = setup();
  env.CACHE.get = async () => {
    throw new Error("synthetic storage unavailable");
  };
  const response = await request("/v1/cache/abc");
  assert.equal(response.status, 500);
  assert.match(await response.text(), /synthetic storage unavailable/);
  assert.equal(events[0].blobs[0], "error");
});

test("stats only query bounded aggregates and preserve independent query errors", async () => {
  const { env, request } = setup();
  const queries = [];
  env.ANALYTICS_SQL.query = async ({ query }) => {
    queries.push(query);
    if (query.includes("events.analyticsEngine"))
      throw new Error("synthetic analytics unavailable");
    return {
      data: [{ hour: "2026-10-01 12:00:00", objects: 25, bytes: 8192 }],
    };
  };
  const stats = await (
    await request("/stats.json?query=SELECT%20secret")
  ).json();
  assert.match(stats.activity.error, /synthetic analytics unavailable/);
  assert.equal(stats.storage.data[0].objects, 25);
  assert.ok(queries.every((q) => q.includes("LIMIT") && !q.includes("secret")));
  assert.ok(queries.some((q) => q.includes("usageReportTimestamp")));
});

import { Client } from "pg";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import { z } from "zod";

import worker from "../../src/cf-server";
import { activeUsdaRelease } from "../../src/server/usda-release/client";
import { PREVIEW_DOCUMENT } from "./preview/document";
import { assertDevDatabaseUrl } from "./state";
import {
  DEV_USER_EMAIL,
  DEV_USER_PASSWORD,
  LOCAL_FIXTURE_VERSION,
} from "./state";
import { handleLocalStorageRequest, type LocalStorageEnv } from "./storage";
import { seedUsdaRelease } from "./usda-synthetic-release";

// Durable Objects, Workflows, and RPC exports remain the production classes.
export * from "../../src/cf-server";

type LocalDevEnv = Env &
  LocalStorageEnv & {
    CUBBY_DEV_ID: string;
    CUBBY_DEV_DB_NAME: string;
    CUBBY_DEV_PROFILE: "offline" | "integrations";
    CUBBY_DEV_MIGRATION_COUNT: string;
    CUBBY_DEV_MIGRATION_HASH: string;
  };

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const databaseRow = z.object({ database: z.string() });
const fixturesRow = z.object({ fixtures_ready: z.boolean() });

// Once per isolate, before any request or queue batch can read USDA.
let usdaSeeded: Promise<void> | undefined;
const seedUsda = (env: LocalDevEnv) =>
  (usdaSeeded ??= seedUsdaRelease(env.USDA_RELEASES, env.USDA_ACTIVE_RELEASE));

function assertLocalEnvironment(request: Request, env: LocalDevEnv) {
  const origin = new URL(env.APP_ORIGIN);
  const database = assertDevDatabaseUrl(env.DATABASE_URL);
  const hyperdrive = new URL(env.HYPERDRIVE.connectionString);
  if (
    !env.CUBBY_DEV_ID ||
    env.E2E_AUTH_TEST_MODE === "true" ||
    !loopback.has(origin.hostname) ||
    new URL(request.url).origin !== origin.origin ||
    database.pathname.slice(1) !== env.CUBBY_DEV_DB_NAME ||
    !(
      loopback.has(hyperdrive.hostname) ||
      /^[a-f0-9]+\.hyperdrive\.local$/u.test(hyperdrive.hostname)
    ) ||
    hyperdrive.pathname.slice(1) !== env.CUBBY_DEV_DB_NAME
  ) {
    throw new Error(
      `Local Worker identity mismatch: request=${new URL(request.url).origin}, configured=${origin.origin}, database=${database.pathname.slice(1)}, Hyperdrive=${hyperdrive.hostname}/${hyperdrive.pathname.slice(1)}, expected=${env.CUBBY_DEV_DB_NAME}`,
    );
  }
}

async function readiness(env: LocalDevEnv, fixturesRequired: boolean) {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
  });
  let fixturesReady = false;
  let migrationsReady = false;
  let usdaReady = false;
  let database: string | null = null;
  try {
    await client.connect();
    const result = await client.query("SELECT current_database() AS database");
    database = databaseRow.parse(result.rows[0]).database;
    if (database !== env.CUBBY_DEV_DB_NAME) {
      throw new Error(
        `Connected database ${database} does not match ${env.CUBBY_DEV_DB_NAME}`,
      );
    }
    if (fixturesRequired) {
      const migrations = await client.query<{ hash: string }>(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
      );
      if (
        migrations.rows.length !== Number(env.CUBBY_DEV_MIGRATION_COUNT) ||
        migrations.rows.at(-1)?.hash !== env.CUBBY_DEV_MIGRATION_HASH
      )
        throw new Error(
          "Local migrations differ from this checkout; restart pnpm dev to migrate",
        );
      migrationsReady = true;
      const fixtures = await client.query(
        "SELECT EXISTS (SELECT 1 FROM cubby_dev_fixture WHERE pack = 'core' AND version = $1 AND state = 'complete') AS fixtures_ready",
        [LOCAL_FIXTURE_VERSION],
      );
      fixturesReady = fixturesRow.parse(fixtures.rows[0]).fixtures_ready;
      // The first status() starts the load; a loading release is not ready yet.
      const usda = await activeUsdaRelease(env).status();
      if (usda.state === "failed")
        throw new Error(
          `USDA release ${usda.release} failed to load: ${usda.error}`,
        );
      usdaReady = usda.state === "ready";
    }
    const ready = !fixturesRequired || (fixturesReady && usdaReady);
    return Response.json(
      {
        devId: env.CUBBY_DEV_ID,
        database,
        fixturesReady,
        migrationsReady,
        usdaReady,
        fixtureVersion: LOCAL_FIXTURE_VERSION,
        ready,
      },
      {
        status: ready ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return Response.json(
      {
        devId: env.CUBBY_DEV_ID,
        database,
        fixturesReady,
        migrationsReady,
        usdaReady,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await client.end();
  }
}

export default {
  ...worker,
  async queue(
    batch: MessageBatch<unknown>,
    env: LocalDevEnv,
    ctx: ExecutionContext,
  ) {
    await seedUsda(env);
    // Production handlers discriminate on their deployed queue names. Local
    // queues retain checkout isolation at transport and normalize at delivery.
    if (batch.queue === `cubby-dev-${env.CUBBY_DEV_ID}-telemetry`)
      return worker.queue(
        { queue: "cubby-telemetry", messages: batch.messages },
        env,
        ctx,
      );
    if (batch.queue === `cubby-dev-${env.CUBBY_DEV_ID}-background`)
      return worker.queue(
        { queue: "cubby-background", messages: batch.messages },
        env,
        ctx,
      );
    if (batch.queue === `cubby-dev-${env.CUBBY_DEV_ID}-purchase`)
      return worker.queue(
        { queue: "cubby-purchase-agent", messages: batch.messages },
        env,
        ctx,
      );
    throw new Error(`Unexpected local queue: ${batch.queue}`);
  },
  async fetch(request: Request, env: LocalDevEnv, ctx: ExecutionContext) {
    try {
      assertLocalEnvironment(request, env);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : String(error),
        { status: 403 },
      );
    }
    await seedUsda(env);
    const url = new URL(request.url);
    if (url.pathname === "/__dev/health" || url.pathname === "/__dev/ready") {
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      return readiness(env, url.pathname === "/__dev/ready");
    }
    if (url.pathname === "/__dev/login") {
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      const destination = new URL(
        url.searchParams.get("next") ?? "/",
        url.origin,
      );
      if (destination.origin !== url.origin)
        return new Response("Same-origin redirect required", { status: 400 });
      const signIn = await worker.fetch(
        new Request(new URL("/api/auth/sign-in/email", url.origin), {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: url.origin },
          body: JSON.stringify({
            email: DEV_USER_EMAIL,
            password: DEV_USER_PASSWORD,
          }),
        }),
        env,
        ctx,
      );
      if (!signIn.ok)
        return new Response(
          `Development sign-in failed: ${signIn.status} ${await signIn.text()}`,
          { status: 502 },
        );
      if (url.searchParams.get("native") === "true") {
        const headers = new Headers(signIn.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(signIn.body, { status: signIn.status, headers });
      }
      const headers = new Headers({
        Location: destination.pathname + destination.search + destination.hash,
        "Cache-Control": "no-store",
      });
      for (const cookie of signIn.headers.getSetCookie())
        headers.append("Set-Cookie", cookie);
      return new Response(null, { status: 303, headers });
    }
    if (url.pathname === "/__dev/preview") {
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      return new Response(PREVIEW_DOCUMENT, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    const storage = await handleLocalStorageRequest(request, env);
    if (storage) return storage;
    const runtimeEnv =
      env.CUBBY_DEV_PROFILE === "offline"
        ? {
            ...env,
            // Refuse the producer handoff so the existing dispatch_failed path
            // records the cause instead of leaving a provider-less run queued.
            PURCHASE_AGENT_QUEUE: {
              metrics: () => env.PURCHASE_AGENT_QUEUE.metrics(),
              send: async () => {
                throw new Error(
                  "Purchase agent unavailable in offline development; use pnpm dev:integrations",
                );
              },
              sendBatch: async () => {
                throw new Error(
                  "Purchase agent unavailable in offline development; use pnpm dev:integrations",
                );
              },
            },
          }
        : env;
    return worker.fetch(request, runtimeEnv, ctx);
  },
};

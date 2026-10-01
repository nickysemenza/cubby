import { tmpdir } from "node:os";
import { createTestHarness } from "wrangler";
import { devSessionSchema as sessionSchema } from "./state";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pollUntil } from "@cubby/shared/retry";
import { stripVTControlCharacters } from "node:util";
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { productId } from "@cubby/schemas/identifiers";
import { searchIndexRepairCountersSchema } from "@cubby/schemas/maintenance";
import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { foodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { productLookupResponseSchema } from "~/contracts/upc.schemas";
import { AwsClient } from "aws4fetch";
import { Pool } from "pg";
import { z } from "zod";
import {
  resolveDevProfile,
  type DevProfile,
} from "../../../../scripts/lib/dev-profile.ts";
import { DEV_USER_EMAIL, LOCAL_FIXTURE_VERSION } from "./state";
import { writeE2ERunBundle } from "../e2e-run-bundle";

declare global {
  interface Window {
    __cubbySmokeHmr?: string;
  }
}

// Failure modes: inherited provider settings reach cloud services; readiness
// identifies another database; a shortcut replaces real sessions; client
// interaction or HMR fails under workerd; signed/public storage disagree;
// restart loses state; another instance shares state; down/reset affects peers.
// This is the acceptance test at those actual browser/runtime boundaries.
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const webRoot = path.join(repoRoot, "apps/web");
const runId = `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const outputDir = path.join(repoRoot, "artifacts/local-dev-smoke", runId);
const cases: Array<{ name: string; status: string; durationMs: number }> = [];
const sessions: Array<{
  profile: DevProfile;
  env: NodeJS.ProcessEnv;
  child?: ChildProcess;
  queueEvents: Set<string>;
}> = [];
const readySchema = z.object({
  devId: z.string(),
  database: z.string(),
  ready: z.boolean(),
  fixturesReady: z.boolean(),
});
const evidence: Record<string, string | number | boolean | string[]> = {};
let browser: Browser | undefined;
let tracedContext: BrowserContext | undefined;
const browserDiagnostics: Array<{ kind: string; message: string }> = [];
const caseFailures: Array<{ name: string; message: string }> = [];
let failure: unknown;

function diagnostic(message: string): string {
  return stripVTControlCharacters(message)
    .replace(
      /^.*\b(?:cookie|authorization|x-api-key):.*$/gimu,
      "[credential header omitted]",
    )
    .slice(0, 2_000);
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "localhost", resolve);
  });
  const address = z.object({ port: z.number() }).parse(listener.address());
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function isolatedSession(suffix: string) {
  const env = { ...process.env };
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "TERM",
    "CUBBY_DEV_SERVICES",
  ]);
  for (const key of Object.keys(env)) if (!allowed.has(key)) delete env[key];
  Object.assign(env, {
    CUBBY_DEV_INSTANCE: `smoke_${runId}_${suffix}`,
    CUBBY_DEV_PROFILE: "offline",
    PORT: String(await availablePort()),
    CUBBY_DEV_INSPECTOR_PORT: String(await availablePort()),
    WRANGLER_SEND_METRICS: "false",
  });
  const profile = resolveDevProfile(repoRoot, env);
  assert.equal(profile.profile, "offline");
  assert.equal(profile.name, `cubby_dev_${profile.id}`);
  assert.equal(
    profile.stateDir,
    path.join(repoRoot, ".cubby-dev", env.CUBBY_DEV_INSTANCE!),
  );
  assert.notEqual(profile.stateDir, path.join(repoRoot, ".cubby-dev"));
  const session: (typeof sessions)[number] = {
    profile,
    env,
    queueEvents: new Set(),
  };
  sessions.push(session);
  return session;
}

function command(
  session: (typeof sessions)[number],
  action: string,
  args: string[] = [],
) {
  const child = spawn(
    "pnpm",
    ["--dir", webRoot, "exec", "tsx", "tooling/dev/index.ts", action, ...args],
    {
      cwd: repoRoot,
      env: session.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-64_000);
      for (const event of output.matchAll(
        /\[background-tasks\] embedding unconfigured [a-zA-Z]+:[a-f0-9-]+/gu,
      )) {
        session.queueEvents.add(event[0]);
      }
    });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Isolated development ${action} exited ${code}; ${output.slice(-8_000)}`,
          ),
        );
    });
  });
  return { child, done, output: () => output };
}

async function start(session: (typeof sessions)[number]) {
  const running = command(session, "start");
  session.child = running.child;
  // Capture rejection immediately: startup failures should remain an ordinary
  // failed case instead of an unhandled rejection while readiness is polled.
  let exited: unknown;
  void running.done.catch((error) => {
    exited = error;
  });
  try {
    return await pollUntil(
      async () => {
        if (exited) throw exited;
        try {
          const response = await fetch(
            `${session.profile.origin}/__dev/ready`,
            { signal: AbortSignal.timeout(3_000) },
          );
          const ready = readySchema.parse(await response.json());
          assert.equal(ready.devId, session.profile.id);
          assert.equal(ready.database, session.profile.name);
          const manifest = sessionSchema.parse(
            JSON.parse(
              await readFile(
                path.join(session.profile.stateDir, "session.json"),
                "utf8",
              ),
            ),
          );
          if (
            response.ok &&
            ready.ready &&
            ready.fixturesReady &&
            manifest.readiness === "ready"
          )
            return manifest;
        } catch (error) {
          if (exited) throw error;
          // Boot, schema setup and seeding are distinct supervisor phases.
        }
        return undefined;
      },
      { label: "isolated development startup", timeoutMs: 180_000 },
    );
  } catch (error) {
    throw new Error(
      `Isolated development startup failed; ${running.output().slice(-8_000)}`,
      { cause: error },
    );
  }
}

async function stop(session: (typeof sessions)[number]) {
  await command(session, "down").done;
  const child = session.child;
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      delay(10_000).then(() => {
        throw new Error("Isolated supervisor stayed alive after down");
      }),
    ]);
  }
  session.child = undefined;
}

async function check(
  name: string,
  run: () => Promise<void>,
  independent = false,
) {
  const started = performance.now();
  try {
    await run();
    cases.push({
      name,
      status: "passed",
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    const message = diagnostic(
      error instanceof Error ? error.message : String(error),
    );
    caseFailures.push({ name, message });
    console.error(`[local-dev-smoke] ${name}: ${message}`);
    cases.push({
      name,
      status: "failed",
      durationMs: Math.round(performance.now() - started),
    });
    if (!independent) throw error;
    failure ??= error;
  } finally {
    console.log(
      `[local-dev-smoke] ${cases.at(-1)?.status}: ${name} (${cases.at(-1)?.durationMs}ms)`,
    );
  }
}

async function databaseCheck(
  profile: DevProfile,
  query: string,
  values: string[] = [],
) {
  assert.match(profile.name, /^cubby_dev_[a-f0-9]{10}$/u);
  const pool = new Pool({
    connectionString: profile.databaseUrl,
    connectionTimeoutMillis: 3_000,
  });
  try {
    const identity = await pool.query("SELECT current_database() AS database");
    assert.equal(identity.rows[0]?.database, profile.name);
    return await pool.query(query, values);
  } finally {
    await pool.end();
  }
}

try {
  await mkdir(outputDir, { recursive: true });
  const first = await isolatedSession("a");
  const second = await isolatedSession("b");
  assert.notEqual(first.profile.name, second.profile.name);
  assert.notEqual(first.profile.stateDir, second.profile.stateDir);
  const key = "cubby-local/local-smoke/synthetic-object.bin";
  const bytes = "synthetic-original-bytes";
  const objectPath = `/__local-storage/s3/cubby-local/${key}`;
  const productName = "Synthetic local runtime acceptance product";

  await check(
    "cold startup without provider credentials identifies its seeded database",
    async () => {
      const manifest = await start(first);
      evidence.firstStartupPhasesMs = JSON.stringify(manifest.phases);
    },
  );
  await check(
    "native development login returns a real signed bearer without redirecting",
    async () => {
      const response = await fetch(
        `${first.profile.origin}/__dev/login?native=true`,
        {
          redirect: "manual",
        },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const token = response.headers.get("set-auth-token");
      assert.ok(token);
      const session = await fetch(
        `${first.profile.origin}/api/auth/get-session`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "cubby-mobile://",
          },
        },
      );
      assert.equal(session.status, 200);
      assert.equal(
        z
          .object({ user: z.object({ email: z.string() }) })
          .parse(await session.json()).user.email,
        DEV_USER_EMAIL,
      );
      assert.equal(
        (
          await fetch(`${first.profile.origin}/__dev/login?native=true`, {
            method: "POST",
          })
        ).status,
        405,
      );
    },
  );
  await check(
    "readiness rejects incomplete or outdated fixtures while health stays available",
    async () => {
      const fixture = await databaseCheck(
        first.profile,
        "SELECT version, state FROM cubby_dev_fixture WHERE pack='core'",
      );
      const marker = z
        .object({ version: z.number(), state: z.string() })
        .parse(fixture.rows[0]);
      try {
        for (const query of [
          "UPDATE cubby_dev_fixture SET state='incomplete' WHERE pack='core'",
          "UPDATE cubby_dev_fixture SET state='complete', version=version+100 WHERE pack='core'",
        ]) {
          await databaseCheck(first.profile, query);
          const response = await fetch(`${first.profile.origin}/__dev/ready`);
          assert.equal(response.status, 503);
          assert.equal(readySchema.parse(await response.json()).ready, false);
          assert.equal(
            (await fetch(`${first.profile.origin}/__dev/health`)).status,
            200,
          );
        }
      } finally {
        await databaseCheck(
          first.profile,
          "UPDATE cubby_dev_fixture SET version=$1::integer, state=$2 WHERE pack='core'",
          [String(marker.version), marker.state],
        );
      }
      assert.equal(
        (await fetch(`${first.profile.origin}/__dev/ready`)).status,
        200,
      );
    },
  );
  // Enable Chromium's Fetch restriction: Authorization requires an explicit
  // allowed header even when other cross-origin request headers use '*'.
  browser = await chromium.launch({
    headless: true,
    args: ["--enable-features=CorsNonWildcardRequestHeadersSupport"],
  });
  const context = await browser.newContext({ baseURL: first.profile.origin });
  tracedContext = context;
  await context.tracing.start({
    screenshots: false,
    snapshots: true,
    sources: false,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    browserDiagnostics.push({
      kind: "pageerror",
      message: error.message.slice(0, 1_000),
    }),
  );
  page.on("requestfailed", (request) =>
    browserDiagnostics.push({
      kind: "requestfailed",
      message: `${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ""}`,
    }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      browserDiagnostics.push({
        kind: "http-error",
        message: `${response.status()} ${new URL(response.url()).pathname}`,
      });
  });

  await check("real login and hydrated browser Product creation", async () => {
    await page.goto("/__dev/login?next=/products?create=true");
    await expect(page).toHaveURL(/\/products\?create=true$/u, {
      timeout: 30_000,
    });
    const authResponse = await context.request.get("/api/auth/get-session");
    assert.equal(authResponse.status(), 200);
    const authenticated = z
      .object({ user: z.object({ email: z.string() }) })
      .parse(await authResponse.json());
    assert.equal(authenticated.user.email, DEV_USER_EMAIL);
    const editor = page.getByRole("dialog");
    const name = editor.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeEditable({ timeout: 30_000 });
    await name.fill(productName);
    await editor.getByRole("button", { name: /^Create$/u }).click();
    await expect(editor).not.toBeVisible({ timeout: 30_000 });
    const product = await databaseCheck(
      first.profile,
      'SELECT count(*)::integer AS count FROM "Product" WHERE name=$1',
      [productName],
    );
    assert.equal(product.rows[0]?.count, 1);
    const realSession = await databaseCheck(
      first.profile,
      'SELECT EXISTS (SELECT 1 FROM "session" s JOIN "user" u ON u.id=s.user_id WHERE u.email=$1) AS exists',
      [DEV_USER_EMAIL],
    );
    assert.equal(realSession.rows[0]?.exists, true);
    evidence.realDatabaseSession = true;
  });

  await check(
    "browser receives a Vite HMR update without navigation",
    async () => {
      const fixture = path.join(first.profile.stateDir, "hmr-smoke.ts");
      const moduleURL = `/@fs${fixture}`;
      const module = (value: string) =>
        `export const marker=${JSON.stringify(value)};\nif(import.meta.hot){ import.meta.hot.accept(next=>{ window.__cubbySmokeHmr=next.marker; }); }\n`;
      await writeFile(fixture, module("before"));
      assert.equal(
        await page.evaluate(
          async (url) => (await import(/* @vite-ignore */ url)).marker,
          moduleURL,
        ),
        "before",
      );
      await writeFile(fixture, module("after"));
      await page.waitForFunction(
        () => window.__cubbySmokeHmr === "after",
        undefined,
        { timeout: 30_000 },
      );
      evidence.browserHmr = true;
    },
  );

  await check(
    "real USDA service binding reads persisted synthetic D1/R2 fixtures",
    async () => {
      const countsResponse = await context.request.get(
        "/api/v1/dashboard/counts",
      );
      assert.equal(countsResponse.status(), 200);
      const counts = dashboardCountsOut.parse(await countsResponse.json());
      assert.equal(counts.usdaFoodsAvailable, true);
      assert.equal(counts.usdaFoods, 3);
      const foodResponse = await context.request.get(
        "/api/v1/usda-food/detail?id=9900001",
      );
      assert.equal(foodResponse.status(), 200);
      const food = foodSummaryWithLinkedProducts.parse(
        await foodResponse.json(),
      );
      assert.equal(food.foodInfo.description, "Synthetic rolled oats");
      evidence.syntheticUsdaFoods = counts.usdaFoods;
    },
    true,
  );
  await check(
    "UPC lookup serves its persisted synthetic UpcLookupCache fixture",
    async () => {
      const upcResponse = await context.request.get(
        "/api/v1/upc/lookup?upc=012345678905",
      );
      assert.equal(upcResponse.status(), 200, await upcResponse.text());
      const lookup = productLookupResponseSchema.parse(
        await upcResponse.json(),
      );
      assert.equal(lookup.name, "Synthetic cotton shirt");
      assert.equal(lookup.upc, "012345678905");
      evidence.syntheticUpcLookup = true;
    },
    true,
  );

  await check(
    "dummy presigned R2 upload shares bytes, metadata, HEAD, Range, CORS and CDN originals",
    async () => {
      const signer = new AwsClient({
        accessKeyId: "dummy",
        secretAccessKey: "dummy",
        service: "s3",
        region: "auto",
      });
      const url = new URL(objectPath, first.profile.origin);
      url.searchParams.set("X-Amz-Expires", "0");
      const signed = await signer.sign(
        new Request(url, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
        }),
        { aws: { signQuery: true, allHeaders: true } },
      );
      const corsSource = createServer((_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><title>Synthetic storage client</title>");
      });
      const corsPage = await context.newPage();
      try {
        await new Promise<void>((resolve) =>
          corsSource.listen(0, "127.0.0.1", resolve),
        );
        const { port } = z
          .object({ port: z.number() })
          .parse(corsSource.address());
        await corsPage.goto(`http://127.0.0.1:${port}`);
        assert.notEqual(new URL(corsPage.url()).origin, first.profile.origin);
        const upload = await corsPage.evaluate(
          async ({ target, body }) => {
            const response = await fetch(target, {
              method: "PUT",
              credentials: "omit",
              body,
              headers: {
                Authorization: "Bearer synthetic-local",
                "x-amz-content-sha256": "synthetic-checksum",
                "Content-Type": "application/octet-stream",
              },
              signal: AbortSignal.timeout(5_000),
            });
            return response.status;
          },
          { target: signed.url, body: bytes },
        );
        assert.equal(upload, 200);
      } finally {
        await corsPage.close();
        corsSource.closeAllConnections();
        corsSource.close();
      }
      for (const pathname of [
        objectPath,
        `/${key}`,
        `/cdn-cgi/image/width=12,format=auto/${key}`,
      ]) {
        const read = await context.request.get(pathname, {
          headers: { "Accept-Encoding": "identity" },
        });
        assert.equal(read.status(), 200);
        assert.equal(await read.text(), bytes);
        assert.equal(
          read.headers()["content-type"],
          "application/octet-stream",
        );
      }
      const head = await context.request.head(`/${key}`);
      assert.equal(head.status(), 200);
      assert.equal(head.headers()["content-length"], String(bytes.length));
      assert.equal((await head.body()).length, 0);
      const range = await context.request.get(objectPath, {
        headers: { Range: "bytes=2-5" },
      });
      assert.equal(range.status(), 206);
      assert.equal(
        range.headers()["content-range"],
        `bytes 2-5/${bytes.length}`,
      );
      assert.equal(await range.text(), bytes.slice(2, 6));
      const invalid = await context.request.get(objectPath, {
        headers: { Range: "bytes=999-" },
      });
      assert.equal(invalid.status(), 416);
      const options = await context.request.fetch(objectPath, {
        method: "OPTIONS",
        headers: {
          Origin: second.profile.origin,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "content-type,x-amz-content-sha256",
        },
      });
      assert.equal(options.status(), 204);
      // Vite can reflect the preflight Origin before the Worker runs; either
      // response permits this synthetic browser origin.
      assert(
        ["*", second.profile.origin].includes(
          options.headers()["access-control-allow-origin"] ?? "",
        ),
      );
      assert(
        (options.headers()["access-control-allow-methods"] ?? "").includes(
          "PUT",
        ),
      );
      assert.equal(
        (
          await context.request.get("/cubby-local/local-smoke/missing.bin")
        ).status(),
        404,
      );
      evidence.storageContracts = [
        "dummy-expired-signature",
        "public-bytes",
        "HEAD",
        "Range",
        "CORS",
        "browser-cross-origin-Authorization-upload",
        "404",
        "original-CDN-fallback",
      ];
    },
  );

  await check(
    "Explorer exposes this instance's local R2, Durable Objects and Workflows",
    async () => {
      const explorer = await context.newPage();
      await explorer.goto("/cdn-cgi/local/explorer");
      await expect(
        explorer.getByText("R2 Buckets", { exact: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
      for (const name of [
        "Durable Objects",
        "Workflows",
        "LOCAL_DEV_STORAGE",
        "SEARCH_INDEX_REPAIR",
      ])
        await expect(
          explorer.getByText(name, { exact: true }).first(),
        ).toBeVisible();
      evidence.explorerBindingsVisible = true;
      evidence.explorerQueueInspectionAvailable = false;
      await explorer.close();
    },
  );

  await check(
    "real background queue consumes the browser-created Product",
    async () => {
      const row = await databaseCheck(
        first.profile,
        'SELECT id FROM "Product" WHERE name=$1',
        [productName],
      );
      const id = productId.parse(row.rows[0]?.id);
      const expected = `[background-tasks] embedding unconfigured product:${id}`;
      await pollUntil(
        () => (first.queueEvents.has(expected) ? true : undefined),
        {
          label:
            "Worker's real background queue consuming the created synthetic Product",
          timeoutMs: 30_000,
        },
      );
      evidence.realBackgroundQueueConsumed = true;
    },
    true,
  );

  await check(
    "Explorer starts and observes the real SearchIndexRepair Workflow",
    async () => {
      const explorerAPI = "/cdn-cgi/local/explorer/api";
      const workflowName = `cubby-dev-${first.profile.id}-search-index-repair`;
      const workflowPath = `${explorerAPI}/workflows/${workflowName}/instances`;
      const workerSelector = `?worker=cubby-dev-${first.profile.id}`;
      const created = await context.request.post(
        workflowPath + workerSelector,
        {
          data: {
            id: "synthetic-smoke",
            params: { requestedAt: new Date().toISOString() },
          },
        },
      );
      assert.equal(created.status(), 200, await created.text());
      const createdBody = z
        .object({
          success: z.literal(true),
          result: z.object({ id: z.string() }),
        })
        .parse(await created.json());
      const detailPath = `${workflowPath}/${createdBody.result.id}${workerSelector}`;
      await pollUntil(
        async () => {
          const response = await context.request.get(detailPath);
          assert.equal(response.status(), 200);
          const detail = z
            .object({
              success: z.literal(true),
              result: z.object({
                status: z.string(),
                output: z.unknown().optional(),
                error: z.object({ message: z.string() }).nullish(),
              }),
            })
            .parse(await response.json());
          assert.notEqual(
            detail.result.status,
            "errored",
            detail.result.error?.message ?? "Workflow errored",
          );
          if (detail.result.status !== "complete") return undefined;
          const output = searchIndexRepairCountersSchema.parse(
            detail.result.output,
          );
          assert(output.scanned > 0);
          evidence.workflowScannedSyntheticEntities = output.scanned;
          return true;
        },
        {
          label: "real SearchIndexRepair Workflow completion",
          timeoutMs: 60_000,
        },
      );
      evidence.realWorkflowCompleted = true;
    },
    true,
  );

  await check(
    "raw Worker CORS permits signed browser transport headers",
    async () => {
      await checkRawStorageCors(page);
    },
  );
  await check(
    "Problems pack retains failed/pending source contracts on reseeding",
    async () => {
      await command(first, "seed", ["problems"]).done;
      const result = await databaseCheck(
        first.profile,
        `SELECT r.notes, r.status,
      r."failureCode", r."endedAt", j.state, j.attempts,
      j."sourceContentHash" = i.sha256 AS source_matches,
      i.status = 'UPLOADED' AND i."storageStatus" = 'available' AND i."renderStatus" = 'verified' AS source_available,
      j."lastError", i.key
      FROM "Run" r JOIN "ImageProcessingJob" j ON j."runId" = r.id
      JOIN "Image" i ON i.id = j."imageId"
      WHERE r.notes IN ($1, $2) AND r."deletedAt" IS NULL`,
        [
          "Synthetic failed photo processing fixture",
          "Synthetic pending photo processing fixture",
        ],
      );
      assert.equal(result.rows.length, 2);
      const failed = result.rows.find((row) => row.state === "failed");
      const pending = result.rows.find((row) => row.state === "pending");
      assert.ok(failed);
      assert.ok(pending);
      assert.equal(failed.status, "failed");
      assert.equal(failed.failureCode, "flue_failed");
      assert.ok(failed.endedAt);
      assert.equal(failed.attempts, 1);
      assert.match(failed.lastError, /Synthetic provider failure/u);
      assert.equal(pending.status, "running");
      assert.equal(pending.endedAt, null);
      assert.equal(pending.attempts, 0);
      for (const row of result.rows) {
        assert.equal(row.source_matches, true);
        assert.equal(row.source_available, true);
        const response = await fetch(
          new URL(`/${row.key}`, first.profile.origin),
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.ok((await response.arrayBuffer()).byteLength > 0);
      }
      await command(first, "seed", ["problems"]).done;
      const repeated = await databaseCheck(
        first.profile,
        'SELECT count(*)::integer AS count FROM "Run" WHERE notes IN ($1, $2) AND "deletedAt" IS NULL',
        [
          "Synthetic failed photo processing fixture",
          "Synthetic pending photo processing fixture",
        ],
      );
      assert.equal(repeated.rows[0]?.count, 2);
    },
  );

  await context.tracing.stop({
    path: path.join(first.profile.stateDir, "smoke-trace.zip"),
  });
  await context.close();
  tracedContext = undefined;
  await rm(path.join(first.profile.stateDir, "hmr-smoke.ts"), { force: true });
  await check(
    "restart preserves uploaded bytes and browser-created Product",
    async () => {
      await stop(first);
      const manifest = await start(first);
      evidence.warmStartupPhasesMs = JSON.stringify(manifest.phases);
      const stored = await fetch(new URL(`/${key}`, first.profile.origin));
      assert.equal(stored.status, 200);
      assert.equal(await stored.text(), bytes);
      const product = await databaseCheck(
        first.profile,
        'SELECT count(*)::integer AS count FROM "Product" WHERE name=$1',
        [productName],
      );
      assert.equal(product.rows[0]?.count, 1);
    },
  );

  await check(
    "second instance has independent database and Worker state",
    async () => {
      await start(second);
      assert.equal(
        (await fetch(new URL(`/${key}`, second.profile.origin))).status,
        404,
      );
      const product = await databaseCheck(
        second.profile,
        'SELECT count(*)::integer AS count FROM "Product" WHERE name=$1',
        [productName],
      );
      assert.equal(product.rows[0]?.count, 0);
      const response = await fetch(new URL(objectPath, second.profile.origin), {
        method: "PUT",
        body: "second-instance-bytes",
      });
      assert.equal(response.status, 200);
      assert.equal(
        await (await fetch(new URL(`/${key}`, first.profile.origin))).text(),
        bytes,
      );
      evidence.distinctInstanceDatabases = true;
    },
  );

  await check("down/reset is confined to its disposable instance", async () => {
    await stop(first);
    await command(first, "reset").done;
    const ready = readySchema.parse(
      await (await fetch(`${second.profile.origin}/__dev/ready`)).json(),
    );
    assert.equal(ready.ready, true);
    assert.equal(
      await (await fetch(new URL(`/${key}`, second.profile.origin))).text(),
      "second-instance-bytes",
    );
    await start(first);
    assert.equal(
      (await fetch(new URL(`/${key}`, first.profile.origin))).status,
      404,
    );
    const product = await databaseCheck(
      first.profile,
      'SELECT count(*)::integer AS count FROM "Product" WHERE name=$1',
      [productName],
    );
    assert.equal(product.rows[0]?.count, 0);
    const deleted = await fetch(new URL(objectPath, second.profile.origin), {
      method: "DELETE",
    });
    assert.equal(deleted.status, 204);
    assert.equal(
      (await fetch(new URL(`/${key}`, second.profile.origin))).status,
      404,
    );
    evidence.storageContracts = [
      ...z.array(z.string()).parse(evidence.storageContracts),
      "DELETE",
    ];
  });
} catch (error) {
  failure = error;
} finally {
  const traceSession = sessions[0];
  if (tracedContext && traceSession) {
    await tracedContext.tracing
      .stop({
        path: path.join(traceSession.profile.stateDir, "smoke-trace.zip"),
      })
      .catch(() => {});
    await tracedContext.close();
  }
  await browser?.close();
  for (const session of sessions) {
    await rm(path.join(session.profile.stateDir, "hmr-smoke.ts"), {
      force: true,
    });
    try {
      await stop(session);
    } catch (error) {
      failure ??= error;
    }
  }
  const status = failure ? "failed" : "passed";
  const resultsPath = path.join(outputDir, "run-results.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    resultsPath,
    `${JSON.stringify({ schemaVersion: 1, status, cases, evidence, caseFailures, browserDiagnostics: browserDiagnostics.slice(-30) }, null, 2)}\n`,
  );
  const manifest = writeE2ERunBundle({
    repoRoot,
    outputDir,
    evidence: [resultsPath],
    kind: "browser",
    status,
    command: [
      "pnpm",
      "--dir",
      "apps/web",
      "exec",
      "tsx",
      "tooling/dev/smoke.ts",
    ],
    cases,
    profile: "offline",
    scenario: "local Worker acceptance",
    fixture: "isolated synthetic core",
    fixtureVersion: LOCAL_FIXTURE_VERSION,
    build: {
      fingerprint: null,
      matchesSource: false,
      details: { runtime: "Vite workerd development" },
    },
    runtime: { browser: browser?.version() ?? "unavailable" },
  });
  console.log(`[local-dev-smoke] Sanitized E2E artifact: ${manifest}`);
}
if (failure)
  throw new Error(
    diagnostic(failure instanceof Error ? failure.message : String(failure)),
  );

/** Wrangler supplies its own HTTP CORS. Read raw Worker responses to guard
 * the adapter's Authorization exception without hiding it behind that layer. */
async function checkRawStorageCors(page: Page): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "cubby-storage-cors-"));
  const harness = createTestHarness({
    root: directory,
    workers: [
      {
        config: {
          name: "cubby-storage-cors",
          main: "worker.ts",
          compatibility_date: "2026-09-01",
          r2_buckets: [
            { binding: "LOCAL_DEV_STORAGE", bucket_name: "cors-contract" },
          ],
          vars: {
            R2_BUCKET_NAME: "cors-contract",
            R2_KEY_PREFIX: "synthetic-storage",
          },
        },
      },
    ],
  });
  let bridgeError: unknown;
  let preflights = 0;
  const bridge = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value))
          for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await harness
        .getWorker()
        .fetch(`http://local${request.url ?? "/"}`, {
          method: request.method,
          headers: [...headers],
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
      if (request.method === "OPTIONS") {
        preflights++;
        assert.equal(result.headers.get("x-worker-adapter"), "true");
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      bridgeError = error;
      response.writeHead(500).end("Synthetic storage transport failure");
    }
  });
  try {
    await writeFile(
      path.join(directory, "worker.ts"),
      `import { handleLocalStorageRequest } from ${JSON.stringify(path.join(import.meta.dirname, "storage.ts"))};
      export default { async fetch(request, env) {
        const response = await handleLocalStorageRequest(request, env) ?? new Response("Missing route", {status:404});
        response.headers.set("X-Worker-Adapter", "true"); return response;
      }};`,
    );
    await harness.listen();
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    const { port } = z.object({ port: z.number() }).parse(bridge.address());
    const endpoint = `http://127.0.0.1:${port}/__local-storage/s3/cors-contract/synthetic-storage/browser.bin?X-Amz-Expires=0`;
    assert.notEqual(new URL(page.url()).origin, new URL(endpoint).origin);
    const result = await page.evaluate(async (target) => {
      const headers = {
        Authorization: "Bearer synthetic-local",
        "x-amz-content-sha256": "synthetic-checksum",
        "Content-Type": "application/octet-stream",
      };
      const upload = await fetch(target, {
        method: "PUT",
        headers,
        body: "synthetic-browser-bytes",
        signal: AbortSignal.timeout(5000),
      });
      const read = await fetch(target, { headers });
      const bytes = await read.text();
      const deleted = await fetch(target, { method: "DELETE", headers });
      const missing = await fetch(target, { headers });
      return {
        upload: upload.status,
        read: read.status,
        bytes,
        deleted: deleted.status,
        missing: missing.status,
      };
    }, endpoint);
    if (bridgeError) throw bridgeError;
    assert.ok(preflights > 0);
    assert.deepEqual(result, {
      upload: 200,
      read: 200,
      bytes: "synthetic-browser-bytes",
      deleted: 204,
      missing: 404,
    });
  } finally {
    bridge.closeAllConnections();
    bridge.close();
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
}

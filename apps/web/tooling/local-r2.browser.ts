import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { createTestHarness } from "wrangler";
import { z } from "zod";
import { writeE2ERunBundle } from "./e2e-run-bundle";

// Failure modes: wildcard CORS headers omit Authorization; Node requests hide
// browser preflight rejection; successful upload responses never persist bytes;
// deletion or missing-object responses lose their cross-origin headers.
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const outputDir = path.join(
  repoRoot,
  "artifacts/local-dev-smoke",
  `r2-browser-${Date.now().toString(36)}`,
);
const directory = await mkdtemp(path.join(tmpdir(), "cubby-r2-browser-"));
const source = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>Synthetic storage client</title>");
});
// Wrangler's HTTP listener supplies development CORS before the Worker runs.
// Forward raw Worker responses so Chromium checks the adapter's own headers.
const storage = createServer(async (request, response) => {
  const active = harness;
  if (!active) {
    response.writeHead(503).end();
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const result = await active
    .getWorker()
    .fetch(`http://local${request.url ?? "/"}`, {
      method: request.method,
      headers: [...headers],
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
  if (request.method === "OPTIONS")
    preflights.push(Object.fromEntries(result.headers));
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
});
let browser: Browser | undefined;
let harness: ReturnType<typeof createTestHarness> | undefined;
let failure: unknown;
const diagnostics: string[] = [];
const preflights: Array<Record<string, string>> = [];
const cases: Array<{ name: string; status: string; durationMs: number }> = [];
const started = performance.now();

try {
  await writeFile(
    path.join(directory, "worker.ts"),
    `import { handleLocalStorageRequest } from ${JSON.stringify(path.join(import.meta.dirname, "local-r2.ts"))};
     export default { async fetch(request, env) {
       const response = await handleLocalStorageRequest(request, env) ?? new Response("Missing route", {status:404});
       response.headers.set("X-Worker-Adapter", "true");
       return response;
     }};`,
  );
  harness = createTestHarness({
    root: directory,
    workers: [
      {
        config: {
          name: "cubby-r2-browser-contract",
          main: "worker.ts",
          compatibility_date: "2026-09-01",
          r2_buckets: [
            { binding: "LOCAL_DEV_STORAGE", bucket_name: "browser-contract" },
          ],
          vars: {
            R2_BUCKET_NAME: "browser-contract",
            R2_KEY_PREFIX: "synthetic-storage",
          },
        },
      },
    ],
  });
  await harness.listen();
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  const { port: storagePort } = z
    .object({ port: z.number() })
    .parse(storage.address());
  const url = new URL(`http://127.0.0.1:${storagePort}`);
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(source.address());
  // Chromium can leave this Fetch restriction disabled; enforce the standard
  // Authorization exception to wildcard request headers in this regression.
  browser = await chromium.launch({
    headless: true,
    args: ["--enable-features=CorsNonWildcardRequestHeadersSupport"],
  });
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error")
      diagnostics.push(message.text().slice(0, 500));
  });
  await page.goto(`http://127.0.0.1:${port}`);
  assert.notEqual(new URL(page.url()).origin, url.origin);
  const endpoint = new URL(
    "/__local-storage/s3/browser-contract/synthetic-storage/browser.bin?X-Amz-Expires=0",
    url,
  ).href;
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
      signal: AbortSignal.timeout(5_000),
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
  assert.deepEqual(result, {
    upload: 200,
    read: 200,
    bytes: "synthetic-browser-bytes",
    deleted: 204,
    missing: 404,
  });
  assert(preflights.length > 0);
  for (const preflight of preflights)
    assert.equal(preflight["x-worker-adapter"], "true");
} catch (error) {
  failure = error;
} finally {
  const version = browser?.version();
  await browser?.close();
  await harness?.close();
  storage.closeAllConnections();
  storage.close();
  source.closeAllConnections();
  source.close();
  await rm(directory, { recursive: true, force: true });
  const status = failure ? "failed" : "passed";
  cases.push({
    name: "browser cross-origin R2 upload/read/delete with Authorization and x-amz headers",
    status,
    durationMs: Math.round(performance.now() - started),
  });
  await mkdir(outputDir, { recursive: true });
  const resultsPath = path.join(outputDir, "run-results.json");
  await writeFile(
    resultsPath,
    `${JSON.stringify({ status, cases, diagnostics, preflights, error: failure instanceof Error ? failure.message : null }, null, 2)}\n`,
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
      "tooling/local-r2.browser.ts",
    ],
    cases,
    profile: "offline",
    scenario: "local R2 browser CORS",
    fixture: "synthetic isolated R2 bytes",
    build: {
      fingerprint: null,
      matchesSource: false,
      details: { runtime: "Wrangler workerd source harness" },
    },
    runtime: { browser: version ?? "unavailable" },
  });
  console.log(`[local-r2-browser] ${status}: ${manifest}`);
}
if (failure)
  throw new Error("Browser R2 CORS failed; see sanitized run-results.json");

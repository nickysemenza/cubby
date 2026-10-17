/**
 * Budgets the Worker bundle (native Build Output) so request-path growth fails the
 * build instead of being found in a later performance sweep.
 *
 * "Entry" is the static import closure loaded for every Worker invocation.
 * "Browser dispatch" adds the browser API adapter's static imports, before
 * loading a particular operation handler.
 * "First request" is what the combined page path loads: the entry's static
 * imports, plus the server entry and router chunks it imports lazily, plus
 * everything those import statically. A route or helper that statically
 * imports a heavy module (an SDK, a generated document) lands it here even if
 * only one rarely used handler calls it — load those inside the handler.
 *
 * Must stay off the first-request path (each has landed here by accident):
 * - Sentry build-time instrumentation. `sentryTanstackStart` injects
 *   `require("@sentry/server-utils")` into pg, pg-pool and other dependencies;
 *   Rolldown then bundles the CommonJS builds of @sentry/core, server-utils and
 *   conventions (a 1.1 MB `assets/cjs-*.js` chunk) beside the ESM copies the
 *   SDK already uses. vite.config.ts sets `buildTimeInstrumentation: false`;
 *   `findSentryOrchestrionInjection` fails the build if it comes back.
 * - Generated tables and contract schemas (entity-field-model.gen, OpenAPI
 *   documents) needed by one route family: import them where used.
 */

import { getWorkerBundleDir } from "@cloudflare/build-output-utils";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MB = 1_000_000;
// Every invocation loads this static entry, including API reads that never
// render a page. Keep unrelated entity metadata behind its consuming handler.
// In 2026-10, removing the helper barrel cut 2.39 MB / 94 files to 1.67 MB / 88.
const ENTRY_BUDGET = 2 * MB;
// The browser API bootstrap was 3.80 MB before title-column generation removed
// the full field model from shortcode resolution (2026-10).
// After generation it measures 3.13 MB / 156 files; keep that saving guarded.
const BROWSER_DISPATCH_BUDGET = 3.25 * MB;
// Measured at 5.35 MB first request / 16.6 MB total when introduced. Sentry 11
// (@sentry/cloudflare) adds a ~1.1 MB chunk (the shared tracer provider,
// attribute conventions, and channel-instrumentation tables) that Cubby never
// uses at runtime because tracing is sampled to 0: 6.27 MB first request /
// 16.9 MB total (since removed: see the orchestrion note below, which brought
// the first request to 5.39 MB / 17.00 MB total). The purchase
// and inventory batch of 2026-10 (settlement, corrections, receiving, identity
// proof) reached 18.01 MB total with an unchanged 6.44 MB first request; the
// total is lazily loaded and far inside Cloudflare's compressed limit, so it
// gets headroom while the request-path budget stays tight. Merging the
// purchase agent into this Worker (2026-10) added its runtime (Agents SDK,
// pi-durable, MCP client; ~1.8 MB, sharing zod, pi-ai, and Sentry with the
// app) as one lazily loaded chunk: 19.34 MB total, first request unchanged at
// 5.41 MB. The agent's Durable Object and queue consumer load it on their
// first event (`server/domains/purchase-import/operations/agent-host.ts`), never on a page.
const FIRST_REQUEST_BUDGET = 6.5 * MB;
const TOTAL_BUDGET = 20 * MB;

const STATIC_IMPORT =
  /(?:import|export)\s*(?:[\w*{}\s,$]*?from\s*)?["'`](\.{1,2}\/[^"'`]+\.js)["'`]/g;
const DYNAMIC_IMPORT = /import\(\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]\s*\)/g;
const REQUEST_PATH_CHUNK = /(?:^|\/)assets\/(?:server|router)-[^/]+\.js$/;
const BROWSER_DISPATCH_CHUNK =
  /(?:^|\/)assets\/browser-operation-dispatch-[^/]+\.js$/;

type Closure = { files: string[]; bytes: number };
type ClosureScope = "entry" | "browserDispatch" | "firstRequest";

function listJs(root: string, directory = ""): string[] {
  return readdirSync(path.join(root, directory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return listJs(root, relative);
    return entry.name.endsWith(".js") ? [relative] : [];
  });
}

export function measureServerClosure(root: string) {
  const sources = new Map(
    listJs(root).map((file) => [
      file,
      readFileSync(path.join(root, file), "utf8"),
    ]),
  );
  const importsOf = (file: string, pattern: RegExp) =>
    [...(sources.get(file) ?? "").matchAll(pattern)].map((match) =>
      path.posix.normalize(
        path.posix.join(path.posix.dirname(file), match[1]!),
      ),
    );
  const requestPathImports = (file: string) => [
    ...importsOf(file, STATIC_IMPORT),
    ...importsOf(file, DYNAMIC_IMPORT).filter((target) =>
      REQUEST_PATH_CHUNK.test(target),
    ),
  ];

  // Breadth-first so each chunk keeps its shortest chain from the entry.
  const traceImports = (importsFor: (file: string) => string[]) => {
    const parent = new Map<string, string | null>([["index.js", null]]);
    const queue = ["index.js"];
    for (let file = queue.shift(); file; file = queue.shift()) {
      for (const target of importsFor(file)) {
        if (parent.has(target) || !sources.has(target)) continue;
        parent.set(target, file);
        queue.push(target);
      }
    }
    return parent;
  };
  const entry = traceImports((file) => importsOf(file, STATIC_IMPORT));
  const browserDispatch = traceImports((file) => [
    ...importsOf(file, STATIC_IMPORT),
    ...importsOf(file, DYNAMIC_IMPORT).filter((target) =>
      BROWSER_DISPATCH_CHUNK.test(target),
    ),
  ]);
  const parent = traceImports(requestPathImports);
  const graphs = { entry, browserDispatch, firstRequest: parent };

  const closure = (files: Iterable<string>): Closure => {
    const list = [...files];
    return {
      files: list,
      bytes: list.reduce((sum, file) => sum + sources.get(file)!.length, 0),
    };
  };
  return {
    entry: closure(entry.keys()),
    browserDispatch: closure(browserDispatch.keys()),
    firstRequest: closure(parent.keys()),
    total: closure(sources.keys()),
    chainTo(file: string, scope: ClosureScope = "firstRequest"): string[] {
      const graph = graphs[scope];
      const chain: string[] = [];
      for (let at: string | null | undefined = file; at; at = graph.get(at))
        chain.unshift(at);
      return graph.has(file) ? chain : [];
    },
    largest(count: number, scope: ClosureScope = "firstRequest") {
      return [...graphs[scope].keys()]
        .map((file) => ({ file, bytes: sources.get(file)!.length }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, count);
    },
  };
}

/**
 * Files carrying Faker's runtime. `@faker-js/faker` is a devDependency for test
 * and dev-seed data only (`tooling/factories`); its locale tables are
 * megabytes, so any Worker chunk containing it means a test seam leaked into
 * production code. The markers are method names Faker's `helpers` module
 * defines and minification preserves as property keys.
 */
export function findBundledFaker(root: string): string[] {
  return listJs(root).filter((file) => {
    const source = readFileSync(path.join(root, file), "utf8");
    return (
      source.includes("weightedArrayElement") && source.includes("fromRegExp")
    );
  });
}

/**
 * Files carrying Sentry's orchestrion runtime hook. Its presence means build
 * time instrumentation rewrote a dependency to `require("@sentry/server-utils")`,
 * which bundles ~1.1 MB of CommonJS Sentry code the Worker never runs (tracing
 * is sampled to 0 and `db-pg-tracing` traces queries itself).
 */
export function findSentryOrchestrionInjection(root: string): string[] {
  return listJs(root).filter((file) =>
    readFileSync(path.join(root, file), "utf8").includes(
      "__SENTRY_ORCHESTRION_INJECT__",
    ),
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const serverRoot = getWorkerBundleDir(process.cwd());
  const faker = findBundledFaker(serverRoot);
  if (faker.length > 0)
    throw new Error(
      `@faker-js/faker reached the Worker bundle (${faker.join(", ")}). It is for tests and dev seeding only; keep tooling/factories and *.fixtures imports out of src/ production code.`,
    );
  const orchestrion = findSentryOrchestrionInjection(serverRoot);
  if (orchestrion.length > 0)
    throw new Error(
      `Sentry build-time instrumentation reached the Worker bundle (${orchestrion.join(", ")}). Keep buildTimeInstrumentation: false in vite.config.ts; it adds ~1.1 MB of CommonJS Sentry code to the first request.`,
    );
  const report = measureServerClosure(serverRoot);
  if (report.browserDispatch.files.length === report.entry.files.length)
    throw new Error(
      "Browser dispatch chunk was not reached from the Worker entry. Update BROWSER_DISPATCH_CHUNK to match the emitted adapter before measuring its budget.",
    );
  const mb = (bytes: number) => `${(bytes / MB).toFixed(2)} MB`;
  console.log(
    `[check-server-closure] entry ${mb(report.entry.bytes)} (${report.entry.files.length} files), browser dispatch ${mb(report.browserDispatch.bytes)} (${report.browserDispatch.files.length} files), first request ${mb(report.firstRequest.bytes)} (${report.firstRequest.files.length} files), total ${mb(report.total.bytes)}`,
  );
  const over: string[] = [];
  if (report.entry.bytes > ENTRY_BUDGET)
    over.push(`entry ${mb(report.entry.bytes)} > ${mb(ENTRY_BUDGET)}`);
  if (report.browserDispatch.bytes > BROWSER_DISPATCH_BUDGET)
    over.push(
      `browser dispatch ${mb(report.browserDispatch.bytes)} > ${mb(BROWSER_DISPATCH_BUDGET)}`,
    );
  if (report.firstRequest.bytes > FIRST_REQUEST_BUDGET)
    over.push(
      `first request ${mb(report.firstRequest.bytes)} > ${mb(FIRST_REQUEST_BUDGET)}`,
    );
  if (report.total.bytes > TOTAL_BUDGET)
    over.push(`total ${mb(report.total.bytes)} > ${mb(TOTAL_BUDGET)}`);
  if (over.length > 0) {
    const scope =
      report.entry.bytes > ENTRY_BUDGET
        ? "entry"
        : report.browserDispatch.bytes > BROWSER_DISPATCH_BUDGET
          ? "browserDispatch"
          : "firstRequest";
    const largest = report
      .largest(12, scope)
      .map(
        ({ file, bytes }) =>
          `  ${mb(bytes)} ${file}\n    via ${report.chainTo(file, scope).join(" -> ")}`,
      );
    throw new Error(
      `Worker bundle over budget: ${over.join("; ")}\nLargest ${scope} chunks:\n${largest.join("\n")}\n` +
        "Load heavy modules inside the handler that uses them (await import()).",
    );
  }
}

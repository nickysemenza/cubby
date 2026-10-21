/**
 * Reports the Worker bundle import closures and rejects concrete build leaks.
 * Byte counts are diagnostic: performance regressions require runtime evidence.
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

/** Logs closure sizes; throws on leaked test code or unwanted instrumentation. */
export function checkServerClosure(cwd: string, previewBuild: boolean) {
  const serverRoot = getWorkerBundleDir(cwd);
  // Local fixture routes belong to preview builds, whose provenance is separate.
  const faker = previewBuild ? [] : findBundledFaker(serverRoot);
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
      "Browser dispatch chunk was not reached from the Worker entry. Update BROWSER_DISPATCH_CHUNK to match the emitted adapter before measuring its closure.",
    );
  const mb = (bytes: number) => `${(bytes / MB).toFixed(2)} MB`;
  console.log(
    `[check-server-closure] entry ${mb(report.entry.bytes)} (${report.entry.files.length} files), browser dispatch ${mb(report.browserDispatch.bytes)} (${report.browserDispatch.files.length} files), first request ${mb(report.firstRequest.bytes)} (${report.firstRequest.files.length} files), total ${mb(report.total.bytes)}`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url)
  checkServerClosure(
    process.cwd(),
    process.env.CUBBY_DEV_PREVIEW_BUILD === "true",
  );

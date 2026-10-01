/**
 * Budgets the Worker bundle (dist/server) so request-path growth fails the
 * build instead of being found in a later performance sweep.
 *
 * "First request" is what one page or API request loads: the entry's static
 * imports, plus the server entry and router chunks it imports lazily, plus
 * everything those import statically. A route or helper that statically
 * imports a heavy module (an SDK, a generated document) lands it here even if
 * only one rarely used handler calls it — load those inside the handler.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MB = 1_000_000;
// Measured at 5.35 MB first request / 16.6 MB total when introduced.
const FIRST_REQUEST_BUDGET = 6 * MB;
const TOTAL_BUDGET = 18 * MB;

const STATIC_IMPORT =
  /(?:import|export)\s*(?:[\w*{}\s,$]*?from\s*)?["'`](\.{1,2}\/[^"'`]+\.js)["'`]/g;
const DYNAMIC_IMPORT = /import\(\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]\s*\)/g;
const REQUEST_PATH_CHUNK = /(?:^|\/)assets\/(?:server|router)-[^/]+\.js$/;

type Closure = { files: string[]; bytes: number };

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
  const parent = new Map<string, string | null>([["index.js", null]]);
  const queue = ["index.js"];
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const target of requestPathImports(file)) {
      if (parent.has(target) || !sources.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }

  const closure = (files: Iterable<string>): Closure => {
    const list = [...files];
    return {
      files: list,
      bytes: list.reduce((sum, file) => sum + sources.get(file)!.length, 0),
    };
  };
  return {
    firstRequest: closure(parent.keys()),
    total: closure(sources.keys()),
    chainTo(file: string): string[] {
      const chain: string[] = [];
      for (let at: string | null | undefined = file; at; at = parent.get(at))
        chain.unshift(at);
      return parent.has(file) ? chain : [];
    },
    largest(count: number) {
      return [...parent.keys()]
        .map((file) => ({ file, bytes: sources.get(file)!.length }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, count);
    },
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const report = measureServerClosure(path.resolve("dist/server"));
  const mb = (bytes: number) => `${(bytes / MB).toFixed(2)} MB`;
  console.log(
    `[check-server-closure] first request ${mb(report.firstRequest.bytes)} (${report.firstRequest.files.length} files), total ${mb(report.total.bytes)}`,
  );
  const over: string[] = [];
  if (report.firstRequest.bytes > FIRST_REQUEST_BUDGET)
    over.push(
      `first request ${mb(report.firstRequest.bytes)} > ${mb(FIRST_REQUEST_BUDGET)}`,
    );
  if (report.total.bytes > TOTAL_BUDGET)
    over.push(`total ${mb(report.total.bytes)} > ${mb(TOTAL_BUDGET)}`);
  if (over.length > 0) {
    const largest = report
      .largest(12)
      .map(
        ({ file, bytes }) =>
          `  ${mb(bytes)} ${file}\n    via ${report.chainTo(file).join(" -> ")}`,
      );
    throw new Error(
      `Worker bundle over budget: ${over.join("; ")}\nLargest request-path chunks:\n${largest.join("\n")}\n` +
        "Load heavy modules inside the handler that uses them (await import()).",
    );
  }
}

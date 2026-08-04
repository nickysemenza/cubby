import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const CLIENT_BUNDLE_BUDGET = {
  gzipBytes: 510 * 1024,
  chunks: 145,
} as const;

const STATIC_FROM =
  /\b(?:import|export)(?!\s*\()[^;]*?from["'](\.\/[^"']+)["']/gu;
const STATIC_SIDE_EFFECT = /\bimport["'](\.\/[^"']+)["']/gu;

export function staticImportSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_FROM, STATIC_SIDE_EFFECT]) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return [...new Set(specifiers)];
}

function findClientEntry(assetsDir: string): string {
  const candidates = readdirSync(assetsDir).filter((file) => {
    if (!/^index-[\w-]+\.js$/u.test(file)) return false;
    const code = readFileSync(resolve(assetsDir, file), "utf8");
    return (
      code.includes("hydrateRoot") && code.includes("__TSS_START_OPTIONS__")
    );
  });
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one hydrated client entry in ${assetsDir}, found ${candidates.length}`,
    );
  }
  return candidates[0]!;
}

export type ClientBundleReport = {
  entry: string;
  chunks: number;
  rawBytes: number;
  gzipBytes: number;
  budget: typeof CLIENT_BUNDLE_BUDGET;
  withinBudget: boolean;
  files: Array<{ file: string; rawBytes: number; gzipBytes: number }>;
};

export function analyzeClientBundle(assetsDir: string): ClientBundleReport {
  const entry = findClientEntry(assetsDir);
  const pending = [entry];
  const closure = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (closure.has(file)) continue;
    closure.add(file);

    const code = readFileSync(resolve(assetsDir, file), "utf8");
    for (const specifier of staticImportSpecifiers(code)) {
      const dependency = basename(specifier);
      if (
        dependency.endsWith(".js") &&
        existsSync(resolve(assetsDir, dependency)) &&
        !closure.has(dependency)
      ) {
        pending.push(dependency);
      }
    }
  }

  const files = [...closure]
    .map((file) => {
      const contents = readFileSync(resolve(assetsDir, file));
      return {
        file,
        rawBytes: contents.byteLength,
        gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
      };
    })
    .sort((a, b) => b.gzipBytes - a.gzipBytes);
  const rawBytes = files.reduce((sum, file) => sum + file.rawBytes, 0);
  const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);

  return {
    entry,
    chunks: files.length,
    rawBytes,
    gzipBytes,
    budget: CLIENT_BUNDLE_BUDGET,
    withinBudget:
      files.length <= CLIENT_BUNDLE_BUDGET.chunks &&
      gzipBytes <= CLIENT_BUNDLE_BUDGET.gzipBytes,
    files,
  };
}

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function runBundleAnalysis(check: boolean): ClientBundleReport {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const assetsDir = resolve(appRoot, "dist/client/assets");
  const report = analyzeClientBundle(assetsDir);
  const reportPath = resolve(appRoot, "dist/client-bundle-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `Client eager closure: ${formatKiB(report.gzipBytes)} gzip across ${report.chunks} chunks`,
  );
  console.log(
    `Budget: ${formatKiB(report.budget.gzipBytes)} gzip across ${report.budget.chunks} chunks`,
  );
  for (const file of report.files.slice(0, 15)) {
    console.log(`${formatKiB(file.gzipBytes).padStart(10)}  ${file.file}`);
  }

  if (check && !report.withinBudget) {
    throw new Error(`Client eager bundle exceeds budget; see ${reportPath}`);
  }
  return report;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  runBundleAnalysis(process.argv.includes("--check"));
}

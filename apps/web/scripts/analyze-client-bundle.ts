import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

// Raised 510 -> 515 KiB when the USDA food page gained its create-product and
// link-to-ingredient actions (#739), which pull ProductForm and the ingredient
// combobox into the eager closure. Raised 515 -> 516 KiB when Expense Analyze
// gained URL-backed route state (#796); its bounded date-preset vocabulary is a
// dedicated 0.1 KiB chunk rather than the full Expense options/UI module. The
// Linux CI build measures 515.3 KiB while the same build measures 514.1 KiB on
// macOS. Headroom here is deliberately small — this budget exists to catch a
// route or dependency that adds tens of KiB, and it only keeps working if
// raising it stays a decision rather than a reflex.
//
// Raised 516 -> 517 KiB for the purchase↔product union + Kit facet (#803), but
// the growth is mostly NOT that PR: the filter-contract refactors (#801, #802)
// landed with this job SKIPPED, because ci-scope judged them not to touch
// client-bundle paths. So their eager-closure growth was never measured, and
// #803 — whose own additions are config entries in already-eager manifests, no
// new module edges — is the first build to weigh the accumulated total. It came
// in ~0.1 KiB over on Linux (515.9 KiB measured on macOS here).
//
// ⚠️ The lesson is about the guard, not the number: a change can grow the eager
// closure and never be measured, so the next PR that happens to touch a client
// path inherits the overage and looks like the culprit. Before trimming code to
// fit, check whether this job actually RAN on the commits that preceded you.
//
// Raised 517 -> 519 KiB for the full Impeccable remediation (#818). The richer
// task-first shell and destination-shaped pending UI add ~1.0 KiB over the
// merge-base. macOS measures 516.6 KiB while Linux/Node 24 measures 517.9 KiB;
// the workspace navigator is already route-split, so 519 KiB records the real
// cross-platform ceiling without weakening the chunk-count guard.
//
// Raised 519 -> 523 KiB for tag-backed Collections. A clean origin/main build
// measures 516.5 KiB on macOS; the three new route-definition chunks and the
// shared collection-tag parser bring this branch to 520.0 KiB. Route bodies
// remain split, and the 145-chunk ceiling stays unchanged.
//
// Raised 523 -> 525 KiB for the image-led Collection locator. The same tree
// measures 522.0 KiB on macOS and 523.1 KiB on Linux/Node 24; the route stays
// split, so the extra 2 KiB records cross-platform variance while retaining
// the existing chunk-count guard.
//
// Raised 525 -> 527 KiB for progressive entity identity images. This branch
// measures 524.1 KiB on macOS and 525.3 KiB on Linux/Node 24; the shared image
// primitive adds only a small eager cost, and the 145-chunk guard remains.
//
// Raised 527 -> 530 KiB for the universal Scan page (#863). The route and
// camera implementation remain split out of the eager closure; the shared
// route/schema/navigation contract measures 527.6 KiB on macOS/Node 26 and
// 528.9 KiB on Linux/Node 24. The closure still fits in 144 chunks, so the
// 145-chunk guard remains unchanged.
//
// Raised 530 -> 536 KiB for manifest-driven relatedness and the focused
// recommendations workbench. Route-less ledger guards and the contribution
// reports bring the Cloudflare build to 536.4 KiB on macOS and 537.4 KiB on
// Linux across the same 146 chunks; 538 KiB leaves bounded cross-platform
// headroom without permitting another eager chunk.
export const CLIENT_BUNDLE_BUDGET = {
  gzipBytes: 538 * 1024,
  chunks: 146,
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

/**
 * Markers that must never appear in a client asset.
 *
 * The server render uses an in-process tRPC link over the domain router
 * (`trpc-transport-server.ts`), selected by `createIsomorphicFn()` in
 * `trpc-transport-isomorphic.ts`. That split is what keeps the router — and the
 * database driver behind it — out of the browser. The Start plugin strips the
 * `.server()` branch at build time, but nothing in the type system enforces it:
 * an ordinary top-level import of server code from shared client code would
 * silently ship the whole server to every visitor. This is the enforcement.
 */
const SERVER_ONLY_MARKERS = [
  // String literals, not identifiers — a minifier renames bindings but must
  // preserve these verbatim, so they are the teeth of this check.
  "No procedure found on path", // @trpc/server's router: the leak that matters
  "drizzle-orm",
  "HYPERDRIVE",
  // An import binding, so a minifier could rename it. Kept as a cheap extra
  // signal; never the only thing standing between the server and the client.
  "unstable_localLink",
];

export function assertNoServerCodeInClient(assetsDir: string): void {
  const leaks: Array<string> = [];
  for (const file of readdirSync(assetsDir)) {
    if (!file.endsWith(".js")) continue;
    const code = readFileSync(resolve(assetsDir, file), "utf8");
    for (const marker of SERVER_ONLY_MARKERS) {
      if (code.includes(marker)) leaks.push(`${file} contains "${marker}"`);
    }
  }
  if (leaks.length > 0) {
    throw new Error(
      `Server-only code leaked into the client bundle:\n  ${leaks.join("\n  ")}\n` +
        "The isomorphic transport split in trpc-transport-isomorphic.ts is not being stripped.",
    );
  }
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

  if (check) {
    assertNoServerCodeInClient(assetsDir);
    if (!report.withinBudget) {
      throw new Error(`Client eager bundle exceeds budget; see ${reportPath}`);
    }
  }
  return report;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  runBundleAnalysis(process.argv.includes("--check"));
}

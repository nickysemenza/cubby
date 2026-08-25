import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * A build report is useful for diagnostics, but a fixed eager-closure size or
 * chunk count is not a reliable product contract. Route splitting is an
 * implementation detail and small platform/toolchain differences can move
 * code between chunks without changing what ships to the browser. Keep this
 * script focused on the security invariant: server-only code must not leak
 * into any client asset.
 */
export type ClientBundleReport = {
  files: Array<{ file: string; rawBytes: number }>;
};

export function analyzeClientBundle(assetsDir: string): ClientBundleReport {
  const files = readdirSync(assetsDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({
      file,
      rawBytes: readFileSync(resolve(assetsDir, file)).byteLength,
    }))
    .sort((a, b) => b.rawBytes - a.rawBytes);
  return { files };
}

/**
 * Markers that must never appear in a client asset.
 *
 * The Start compiler extracts server-function handlers, but an ordinary
 * top-level import of server code from shared client code could still ship the
 * whole server to every visitor. This is the enforcement boundary.
 */
const SERVER_ONLY_MARKERS = ["drizzle-orm", "HYPERDRIVE"];

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
        "The isomorphic transport split is not being stripped.",
    );
  }
}

export function runBundleAnalysis(check: boolean): ClientBundleReport {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const assetsDir = resolve(appRoot, "dist/client/assets");
  const report = analyzeClientBundle(assetsDir);
  const reportPath = resolve(appRoot, "dist/client-bundle-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Client assets: ${report.files.length} JavaScript files`);
  for (const file of report.files.slice(0, 15)) {
    console.log(`${String(file.rawBytes).padStart(10)} bytes  ${file.file}`);
  }

  if (check) assertNoServerCodeInClient(assetsDir);
  return report;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  runBundleAnalysis(process.argv.includes("--check"));
}

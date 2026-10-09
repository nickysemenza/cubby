/**
 * Verifies no server-only code leaked into the client bundle (dist/client).
 *
 * The only remaining guard (after the service worker's removal) that
 * drizzle/HYPERDRIVE never reach a browser — the isomorphic transport split
 * must strip them from every client-bound chunk.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { walkFiles } from "../../../scripts/lib/tree-digest.ts";

const CLIENT_DIR = path.resolve("dist/client");
const WORKER_DIR = path.resolve("dist/server");
const SERVER_ONLY_MARKERS = ["drizzle-orm", "HYPERDRIVE"];

async function serverCodeLeaks(files: readonly string[]): Promise<string[]> {
  const leaks: string[] = [];
  for (const file of files) {
    if (path.extname(file) !== ".js") continue;
    const code = await readFile(file, "utf8");
    for (const marker of SERVER_ONLY_MARKERS) {
      if (code.includes(marker))
        leaks.push(`${path.basename(file)} contains "${marker}"`);
    }
  }
  return leaks;
}

export async function assertNoServerCodeInClient(
  clientDirectory: string,
): Promise<void> {
  const leaks = await serverCodeLeaks(
    walkFiles(clientDirectory, { includeSymlinks: true }),
  );
  if (leaks.length === 0) return;
  throw new Error(
    `Server-only code leaked into the client bundle:\n  ${leaks.join("\n  ")}\n` +
      "The isomorphic transport split is not being stripped.",
  );
}

// Each recipebridge package carries exports the others lack
// (scripts/build-wasm.sh). Hashed asset names do not say which build an asset
// is, so match on an export name in the binary instead.
const WASM_EXCLUSIONS = [
  { directory: "Worker", forbidden: "open_book" },
  { directory: "client", forbidden: "compact_browser_page" },
] as const;

export async function assertWasmSplit(
  clientDirectory: string,
  workerDirectory: string,
): Promise<void> {
  const roots = { client: clientDirectory, Worker: workerDirectory };
  const leaks: string[] = [];
  for (const { directory, forbidden } of WASM_EXCLUSIONS) {
    for (const file of walkFiles(roots[directory], { includeSymlinks: true })) {
      if (path.extname(file) !== ".wasm") continue;
      if ((await readFile(file)).includes(forbidden))
        leaks.push(`${directory} ${path.basename(file)} exports ${forbidden}`);
    }
  }
  if (leaks.length === 0) return;
  throw new Error(
    `A recipebridge wasm package landed in the wrong bundle:\n  ${leaks.join("\n  ")}`,
  );
}

const DEV_ONLY_ROUTES = ["/__dev/", "/__local-storage/s3/", "/cdn-cgi/local/"];

export async function assertNoDevRoutes(directory: string): Promise<void> {
  for (const file of walkFiles(directory, { includeSymlinks: true })) {
    if (path.extname(file) !== ".js") continue;
    const code = await readFile(file, "utf8");
    if (DEV_ONLY_ROUTES.some((route) => code.includes(route))) {
      throw new Error(
        `Local development route leaked into production bundle: ${file}`,
      );
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  await assertNoServerCodeInClient(CLIENT_DIR);
  await assertWasmSplit(CLIENT_DIR, WORKER_DIR);
  // Dev-only links (sign-in's dev login, the footer's Local Explorer) are gated
  // on import.meta.env.DEV, which every `vite build`, local preview included,
  // replaces with false.
  await assertNoDevRoutes(CLIENT_DIR);
  if (process.env.CUBBY_DEV_PREVIEW_BUILD !== "true")
    await assertNoDevRoutes(WORKER_DIR);
  console.log(
    "[check-client-bundle] no server-only code, misplaced wasm, or dev routes in production output",
  );
}

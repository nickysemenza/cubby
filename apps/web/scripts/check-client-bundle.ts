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

export async function assertNoDevLoginInWorker(
  workerDirectory: string,
): Promise<void> {
  for (const file of walkFiles(workerDirectory, { includeSymlinks: true })) {
    if (path.extname(file) !== ".js") continue;
    const code = await readFile(file, "utf8");
    if (
      ["/__dev/", "/__local-storage/s3/"].some((route) => code.includes(route))
    ) {
      throw new Error(
        `Local development route leaked into production Worker bundle: ${file}`,
      );
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  await assertNoServerCodeInClient(CLIENT_DIR);
  if (process.env.CUBBY_DEV_PREVIEW_BUILD !== "true")
    await assertNoDevLoginInWorker(WORKER_DIR);
  console.log("[check-client-bundle] no server-only code in dist/client");
}

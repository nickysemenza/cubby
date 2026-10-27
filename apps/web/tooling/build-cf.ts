import {
  readBuildOutput,
  writeWorkerConfig,
} from "@cloudflare/build-output-utils";
import { execFileSync } from "node:child_process";
import { type FSWatcher, rmSync, watch } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runOrThrow } from "cubby/tooling/run";

const webRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const run = (command: string, args: string[], env = process.env) => {
  execFileSync(command, args, { cwd: webRoot, stdio: "inherit", env });
};

async function buildCloudflare() {
  run(process.execPath, ["../../scripts/ensure.ts", "wasm"]);
  run(process.execPath, ["../../scripts/ensure.ts", "generate"]);
  rmSync(path.join(webRoot, ".cloudflare/output"), {
    recursive: true,
    force: true,
  });
  run("pnpm", ["exec", "cf", "build"], {
    ...process.env,
    DEPLOY_TARGET: "cloudflare",
    NODE_ENV: "production",
  });
  // Sentry owns maps. Keep bundle maps for Sentry/diagnostics, but do not
  // upload them again through cf (the combined map exceeds Cloudflare's limit).
  const output = await readBuildOutput(webRoot);
  for (const [directoryName, worker] of Object.entries(output.workers)) {
    const { manifest, ...config } = worker.config;
    if (!manifest) continue;
    await writeWorkerConfig({
      root: webRoot,
      directoryName,
      config,
      manifest: {
        ...manifest,
        modules: Object.fromEntries(
          Object.entries(manifest.modules).filter(
            ([, module]) => module.type !== "sourcemap",
          ),
        ),
      },
    });
  }
  run("pnpm", ["exec", "tsx", "tooling/checks/check-client-bundle.ts"]);
  run("pnpm", ["exec", "tsx", "tooling/checks/check-server-closure.ts"]);
}

/**
 * Make the built Worker current. Nx owns staleness: its build-cf key is the
 * build's content inputs, so a current build is a cache hit (restored or left
 * in place) and any input change rebuilds the complete client/Worker pair.
 */
export const buildWebWorker = (signal?: AbortSignal) =>
  runOrThrow(
    "pnpm",
    ["exec", "nx", "run", "@cubby/web:build-cf", "--outputStyle=stream"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      signal,
      describe: (status) => `Web build failed with exit ${status}`,
    },
  );

// Outputs, caches and test evidence; edits here never change the build.
const IGNORED_PARTS = new Set([
  ".cloudflare",
  ".cubby-dev",
  ".git",
  ".nx",
  ".vitest",
  "artifacts",
  "blob-report",
  "dist",
  "node_modules",
  "playwright-report",
  "target",
  "test-results",
  "tests",
]);

/**
 * Rerun the Nx build after each burst of source edits. Every run produces the
 * complete client/Worker pair (never a partial Vite watch cycle), and an edit
 * outside build-cf's inputs is a cache hit. A test started mid-rebuild can see
 * the output being replaced; rerun it after `[web watch] current`.
 */
async function watchWebBuild(signal: AbortSignal) {
  let changed: () => void = () => {};
  let pending = false;
  const notify = (_event: string, file: string | Buffer | null) => {
    if (
      file &&
      String(file)
        .split(path.sep)
        .some((part) => IGNORED_PARTS.has(part))
    )
      return;
    pending = true;
    changed();
  };
  const watchers: FSWatcher[] = [
    "apps/web",
    "packages",
    "recipebridge",
    "cookbook-wasm",
    "scripts",
    "docs",
    ".agents/skills",
  ].map((root) =>
    watch(path.join(repoRoot, root), { recursive: true, signal }, notify),
  );
  try {
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        changed = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (pending) resolve();
      });
      // Coalesce a save burst (formatters, multi-file edits) into one build.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (signal.aborted) break;
      pending = false;
      try {
        await buildWebWorker(signal);
        console.log("[web watch] current");
      } catch (error) {
        // An unchanged failure waits for the next edit instead of looping.
        if (!signal.aborted) console.error(error);
      }
    }
  } finally {
    for (const watcher of watchers) watcher.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.includes("--watch")) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await watchWebBuild(controller.signal);
  } else await buildCloudflare();
}

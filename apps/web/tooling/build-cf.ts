import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  ensureWebBuild,
  webBuildNeedsBuild,
  webBuildSourceFingerprint,
  writeWebBuildProvenance,
} from "./web-build-provenance";

const webRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const run = (command: string, args: string[], env = process.env) => {
  execFileSync(command, args, { cwd: webRoot, stdio: "inherit", env });
};

function buildCloudflare() {
  run(process.execPath, ["../../scripts/generator/ensure.ts"]);
  run("pnpm", ["exec", "nx", "run", "@cubby/mcp-apps:build"]);
  rmSync(path.join(webRoot, "dist"), { recursive: true, force: true });
  const source = webBuildSourceFingerprint(repoRoot);
  run("pnpm", ["exec", "vite", "build"], {
    ...process.env,
    DEPLOY_TARGET: "cloudflare",
    NODE_ENV: "production",
  });
  run("pnpm", ["exec", "tsx", "scripts/check-client-bundle.ts"]);
  run("pnpm", ["exec", "tsx", "scripts/check-server-closure.ts"]);
  console.log(
    `[web build] Provenance: ${writeWebBuildProvenance(repoRoot, source)}`,
  );
}

/** Rebuild the complete client/Worker pair; never stamp a partial Vite watch cycle. */
export async function watchWebBuild(
  root: string,
  build: () => void | Promise<void>,
  options: {
    intervalMs?: number;
    signal: AbortSignal;
    onError?: (error: Error) => void;
  },
): Promise<void> {
  let failedSource: string | undefined;
  while (!options.signal.aborted) {
    const source = webBuildSourceFingerprint(root);
    if (source !== failedSource && webBuildNeedsBuild(root)) {
      try {
        await build();
        webBuildNeedsBuild(root, true);
        failedSource = undefined;
      } catch (error) {
        // An edit during compilation retries the new content. A compiler error
        // in unchanged content waits for an edit instead of rebuilding forever.
        failedSource = source;
        (options.onError ?? console.error)(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (!options.signal.aborted) {
      try {
        await pause(options.intervalMs ?? 2000, undefined, {
          signal: options.signal,
        });
      } catch (error) {
        if (!options.signal.aborted) throw error;
      }
    }
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
    await watchWebBuild(repoRoot, buildCloudflare, {
      signal: controller.signal,
    });
  } else if (process.argv.includes("--ensure")) {
    console.log(
      `[web build] ${await ensureWebBuild(repoRoot, buildCloudflare, process.env.CUBBY_E2E_PREBUILT_WEB === "1")}`,
    );
  } else buildCloudflare();
}

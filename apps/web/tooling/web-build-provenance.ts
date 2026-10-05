import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  type BuildSource,
  sourceFingerprint,
} from "../../../scripts/lib/source-fingerprint.ts";
import { digestFiles, walkFiles } from "../../../scripts/lib/tree-digest.ts";

const buildStampSchema = z.object({
  schemaVersion: z.literal(2),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceDirty: z.boolean(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  previewBuild: z.boolean(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  fileCount: z.number().int().nonnegative(),
});

type BuildStamp = z.infer<typeof buildStampSchema>;

interface BuildFingerprint {
  fingerprint: string;
  fileCount: number;
}

export interface WebBuildProvenance {
  fingerprint: string | null;
  /** Current output was built from the current content, including dirty edits. */
  sourceFresh: boolean;
  /** Current output is also exactly replayable from a clean commit. */
  matchesSource: boolean;
  details: {
    reason: string;
    sourceCommit?: string;
    sourceDirty?: boolean;
    sourceFingerprint?: string;
    previewBuild?: boolean;
    buildMatches?: boolean;
    fileCount?: number;
  };
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

// upload-artifact omits hidden files from the bundle consumed by E2E.
const filesUnder = (target: string): string[] =>
  walkFiles(target, { skip: (name) => name.startsWith(".") });

function buildFingerprint(repoRoot: string): BuildFingerprint {
  const webRoot = path.join(repoRoot, "apps/web");
  const required = [
    path.join(webRoot, "dist/client"),
    path.join(webRoot, "dist/server/index.js"),
    path.join(repoRoot, "packages/wasm/recipebridge_bg.wasm"),
  ];
  for (const target of required) {
    if (!existsSync(target))
      throw new Error(
        `Missing web build output: ${path.relative(repoRoot, target)}`,
      );
  }
  // Only deployed code and generated WASM enter this digest. The dist/server
  // directory also contains Wrangler variables and local .dev.vars files.
  const files = [
    ...required.flatMap(filesUnder),
    ...filesUnder(path.join(webRoot, "dist/server/assets")),
    ...filesUnder(path.join(repoRoot, "packages/wasm/recipebridge.js")),
    ...filesUnder(path.join(repoRoot, "packages/wasm/recipebridge_bg.js")),
    ...filesUnder(path.join(repoRoot, "packages/wasm/package.json")),
  ].sort();
  return {
    fingerprint: digestFiles(repoRoot, files),
    fileCount: files.length,
  };
}

function stampPath(repoRoot: string): string {
  return path.join(repoRoot, "apps/web/dist/web-build-provenance.json");
}

const WEB_BUILD_SOURCE = {
  globs: [
    "apps/web/src/**",
    "apps/web/public/**",
    "apps/web/tooling/**",
    "apps/web/scripts/**",
    "apps/web/*.{ts,json,jsonc,toml,html}",
    "apps/mcp-apps/**",
    "packages/**",
    "recipebridge/**",
    "scripts/**",
    "*.{json,jsonc,yaml,yml,toml,lock}",
    ".npmrc",
  ],
  generatedRoots: [
    "apps/web/src",
    "apps/web/public",
    "apps/mcp-apps",
    "packages",
  ],
} satisfies BuildSource;

export function webBuildSourceFingerprint(repoRoot: string): string {
  return sourceFingerprint(repoRoot, {
    ...WEB_BUILD_SOURCE,
    seed: `preview-build:${process.env.CUBBY_DEV_PREVIEW_BUILD === "true"}`,
  });
}

export function writeWebBuildProvenance(
  repoRoot: string,
  expectedSourceFingerprint?: string,
): string {
  const fingerprint = webBuildSourceFingerprint(repoRoot);
  if (
    expectedSourceFingerprint !== undefined &&
    fingerprint !== expectedSourceFingerprint
  )
    throw new Error(
      "Source changed during the web build; refusing to stamp potentially stale output. Rebuild with stable source inputs.",
    );
  const build = buildFingerprint(repoRoot);
  const stamp: BuildStamp = {
    schemaVersion: 2,
    sourceCommit: git(repoRoot, ["rev-parse", "HEAD"]),
    sourceDirty: git(repoRoot, ["status", "--porcelain"]).length > 0,
    sourceFingerprint: fingerprint,
    previewBuild: process.env.CUBBY_DEV_PREVIEW_BUILD === "true",
    ...build,
  };
  const output = stampPath(repoRoot);
  writeFileSync(output, `${JSON.stringify(stamp, null, 2)}\n`);
  return output;
}

export function readWebBuildProvenance(repoRoot: string): WebBuildProvenance {
  const output = stampPath(repoRoot);
  if (!existsSync(output))
    return {
      fingerprint: null,
      sourceFresh: false,
      matchesSource: false,
      details: { reason: "missing-build-stamp" },
    };
  let stamp: BuildStamp;
  try {
    stamp = buildStampSchema.parse(JSON.parse(readFileSync(output, "utf8")));
  } catch {
    return {
      fingerprint: null,
      sourceFresh: false,
      matchesSource: false,
      details: { reason: "invalid-build-stamp" },
    };
  }
  let buildMatches = false;
  try {
    const currentBuild = buildFingerprint(repoRoot);
    buildMatches =
      currentBuild.fingerprint === stamp.fingerprint &&
      currentBuild.fileCount === stamp.fileCount;
  } catch {
    return {
      fingerprint: stamp.fingerprint,
      sourceFresh: false,
      matchesSource: false,
      details: {
        reason: "missing-build-output",
        sourceCommit: stamp.sourceCommit,
        sourceDirty: stamp.sourceDirty,
        buildMatches: false,
        fileCount: stamp.fileCount,
      },
    };
  }
  const sourceMatches =
    stamp.sourceCommit === git(repoRoot, ["rev-parse", "HEAD"]) &&
    stamp.sourceFingerprint === webBuildSourceFingerprint(repoRoot);
  const clean =
    !stamp.sourceDirty && git(repoRoot, ["status", "--porcelain"]).length === 0;
  return {
    fingerprint: stamp.fingerprint,
    sourceFresh: sourceMatches && buildMatches,
    matchesSource: sourceMatches && buildMatches && clean,
    details: {
      reason: !buildMatches
        ? "build-output-changed"
        : !sourceMatches
          ? "source-changed"
          : clean
            ? "verified"
            : "verified-local-content",
      sourceCommit: stamp.sourceCommit,
      sourceDirty: stamp.sourceDirty,
      sourceFingerprint: stamp.sourceFingerprint,
      previewBuild: stamp.previewBuild,
      buildMatches,
      fileCount: stamp.fileCount,
    },
  };
}

export function webBuildNeedsBuild(
  repoRoot: string,
  requirePrebuilt = false,
): boolean {
  const provenance = readWebBuildProvenance(repoRoot);
  if (requirePrebuilt && !provenance.sourceFresh)
    throw new Error(
      `Invalid prebuilt web bundle: ${provenance.details.reason}. Run the web build before E2E.`,
    );
  return !provenance.sourceFresh;
}

export async function ensureWebBuild(
  repoRoot: string,
  build: (skipCache: boolean) => void | Promise<void>,
  requirePrebuilt = false,
): Promise<"reused" | "built"> {
  if (!webBuildNeedsBuild(repoRoot, requirePrebuilt)) return "reused";
  await build(false);
  // An older/incompletely keyed Nx cache entry can restore a stale stamp.
  // Rebuild only when content verification rejects that restoration.
  if (webBuildNeedsBuild(repoRoot)) await build(true);
  webBuildNeedsBuild(repoRoot, true);
  return "built";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const provenance = readWebBuildProvenance(repoRoot);
  console.log(JSON.stringify(provenance));
  process.exitCode = provenance.sourceFresh ? 0 : 1;
}

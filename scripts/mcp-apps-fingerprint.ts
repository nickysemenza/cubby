import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { digestFiles, walkFiles } from "./lib/tree-digest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_APPS_DIST = join(ROOT, "apps/mcp-apps/dist");
export const MCP_APPS_BUNDLE = "app.html";
export const MCP_APPS_FINGERPRINT = ".input-fingerprint";

export const mcpAppsInputFiles = (root = ROOT): string[] => {
  const appRoot = join(root, "apps/mcp-apps");
  const requiredFiles = [
    join(appRoot, "app.html"),
    join(appRoot, "build.mjs"),
    join(appRoot, "package.json"),
    join(appRoot, "vite.config.ts"),
    join(root, "package.json"),
    join(root, "pnpm-lock.yaml"),
    join(root, "pnpm-workspace.yaml"),
    join(root, "tsconfig.json"),
    join(root, "scripts/mcp-apps-fingerprint.ts"),
  ];
  const requiredDirectories = [
    join(appRoot, "src"),
    join(root, "packages/design-tokens"),
  ];

  for (const path of [...requiredFiles, ...requiredDirectories]) {
    if (!existsSync(path)) throw new Error(`Missing MCP Apps input: ${path}`);
  }

  return [
    ...requiredFiles,
    ...requiredDirectories.flatMap((directory) => walkFiles(directory)),
  ].sort();
};

export const mcpAppsSourceFingerprint = (root = ROOT): string =>
  digestFiles(root, mcpAppsInputFiles(root));

export const mcpAppsBundleIsCurrent = (
  fingerprint: string,
  dist = MCP_APPS_DIST,
): boolean => {
  const bundle = join(dist, MCP_APPS_BUNDLE);
  const marker = join(dist, MCP_APPS_FINGERPRINT);
  return (
    existsSync(bundle) &&
    statSync(bundle).isFile() &&
    existsSync(marker) &&
    readFileSync(marker, "utf8").trim() === fingerprint
  );
};

export const stampMcpAppsBundle = (
  fingerprint: string,
  dist = MCP_APPS_DIST,
): void => {
  writeFileSync(join(dist, MCP_APPS_FINGERPRINT), `${fingerprint}\n`);
};

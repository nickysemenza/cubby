import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MCP_APPS_BUNDLE,
  MCP_APPS_FINGERPRINT,
  mcpAppsBundleIsCurrent,
  mcpAppsInputFiles,
  mcpAppsSourceFingerprint,
  stampMcpAppsBundle,
} from "./mcp-apps-fingerprint.ts";

const fixtureFiles = [
  "apps/mcp-apps/app.html",
  "apps/mcp-apps/build.mjs",
  "apps/mcp-apps/package.json",
  "apps/mcp-apps/vite.config.ts",
  "apps/mcp-apps/src/usda-picker-entry.ts",
  "apps/mcp-apps/src/app.css",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "scripts/mcp-apps-fingerprint.ts",
  "packages/design-tokens/package.json",
  "packages/design-tokens/brand.css",
] as const;

const createFixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "cubby-mcp-apps-"));
  for (const file of fixtureFiles) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${file}\n`);
  }
  return root;
};

test("MCP Apps fingerprint covers every bundle input category", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = mcpAppsSourceFingerprint(root);

  for (const file of [
    "apps/mcp-apps/src/usda-picker-entry.ts",
    "apps/mcp-apps/src/app.css",
    "packages/design-tokens/brand.css",
    "apps/mcp-apps/package.json",
    "pnpm-lock.yaml",
  ]) {
    const path = join(root, file);
    writeFileSync(path, `changed ${file}\n`);
    assert.notEqual(mcpAppsSourceFingerprint(root), original, file);
    writeFileSync(path, `${file}\n`);
    assert.equal(mcpAppsSourceFingerprint(root), original, file);
  }

  const inputs = mcpAppsInputFiles(root);
  assert.ok(inputs.some((path) => path.endsWith("usda-picker-entry.ts")));
  assert.ok(inputs.some((path) => path.endsWith("brand.css")));
  utimesSync(join(root, "apps/mcp-apps/src/app.css"), 1, 1);
  assert.equal(mcpAppsSourceFingerprint(root), original);
});

test("MCP Apps bundle reuse requires both the expected bundle and fingerprint", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "cubby-mcp-apps-dist-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));

  stampMcpAppsBundle("current", dist);
  assert.equal(mcpAppsBundleIsCurrent("current", dist), false);
  writeFileSync(join(dist, MCP_APPS_BUNDLE), "<html></html>\n");
  assert.equal(mcpAppsBundleIsCurrent("other", dist), false);
  assert.equal(mcpAppsBundleIsCurrent("current", dist), true);
  assert.equal(
    join(dist, MCP_APPS_FINGERPRINT).endsWith(".input-fingerprint"),
    true,
  );
});

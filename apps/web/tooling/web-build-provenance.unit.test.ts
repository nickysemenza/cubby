import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureWebBuild,
  readWebBuildProvenance,
  webBuildNeedsBuild,
  webBuildSourceFingerprint,
  writeWebBuildProvenance,
} from "./web-build-provenance";

// Failure modes: two dirty revisions share HEAD; untracked/config/lock changes
// evade freshness; changed output is trusted; a prebuilt flag bypasses checks;
// secrets or local artifacts unnecessarily invalidate an otherwise current build.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-provenance-"));
  roots.push(root);
  const put = (file: string, content = "synthetic") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  put(
    ".gitignore",
    "apps/web/dist/\npackages/wasm/\n.env*\nartifacts/\n*.gen.ts\n",
  );
  put("apps/web/src/example.ts");
  put("apps/web/vite.config.ts");
  put("pnpm-lock.yaml");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.test",
      "commit",
      "--quiet",
      "-m",
      "Synthetic fixture",
    ],
    { cwd: root },
  );
  put("apps/web/dist/client/main.js");
  put("apps/web/dist/server/index.js");
  put("packages/wasm/recipebridge_bg.wasm");
  return { root, put };
}
describe("web build freshness", () => {
  // Preview builds compile a different app mode and must not satisfy a normal
  // E2E build request merely because their source files are unchanged.
  it("rejects reuse across preview and ordinary build modes", () => {
    const previous = process.env.CUBBY_DEV_PREVIEW_BUILD;
    try {
      delete process.env.CUBBY_DEV_PREVIEW_BUILD;
      const { root } = fixture();
      writeWebBuildProvenance(root);
      process.env.CUBBY_DEV_PREVIEW_BUILD = "true";
      expect(webBuildNeedsBuild(root)).toBe(true);
      writeWebBuildProvenance(root);
      expect(webBuildNeedsBuild(root)).toBe(false);
      delete process.env.CUBBY_DEV_PREVIEW_BUILD;
      expect(webBuildNeedsBuild(root)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CUBBY_DEV_PREVIEW_BUILD;
      else process.env.CUBBY_DEV_PREVIEW_BUILD = previous;
    }
  });
  // A source edit while Vite runs must never be attributed to its older output.
  it("refuses to stamp output after source changes during compilation", () => {
    const { root, put } = fixture();
    const expected = webBuildSourceFingerprint(root);
    put("apps/web/src/example.ts", "edited during compilation");
    expect(() => writeWebBuildProvenance(root, expected)).toThrow(
      /source changed during.*build/iu,
    );
    expect(
      existsSync(path.join(root, "apps/web/dist/web-build-provenance.json")),
    ).toBe(false);
    const current = webBuildSourceFingerprint(root);
    writeWebBuildProvenance(root, current);
    expect(readWebBuildProvenance(root).sourceFresh).toBe(true);
  });
  it("reuses current output and repairs an invalid Nx cache restoration", async () => {
    const { root } = fixture();
    writeWebBuildProvenance(root);
    await expect(
      ensureWebBuild(root, () => {
        throw new Error("unexpected build");
      }),
    ).resolves.toBe("reused");
    rmSync(path.join(root, "apps/web/dist/web-build-provenance.json"));
    const cacheModes: boolean[] = [];
    await expect(
      ensureWebBuild(root, (force) => {
        cacheModes.push(force);
        // Simulate a cache restoration with no valid provenance on first run.
        if (force) writeWebBuildProvenance(root);
      }),
    ).resolves.toBe("built");
    expect(cacheModes).toEqual([false, true]);
    expect(readWebBuildProvenance(root).sourceFresh).toBe(true);
  });
  it("reuses the same dirty source content without claiming clean replayability", () => {
    const { root, put } = fixture();
    put("apps/web/src/example.ts", "dirty version one");
    writeWebBuildProvenance(root);
    expect(readWebBuildProvenance(root)).toMatchObject({
      sourceFresh: true,
      matchesSource: false,
    });
    expect(webBuildNeedsBuild(root, true)).toBe(false);
    put("apps/web/src/example.ts", "dirty version two");
    expect(readWebBuildProvenance(root).sourceFresh).toBe(false);
    expect(() => webBuildNeedsBuild(root, true)).toThrow(
      /prebuilt.*source-changed/iu,
    );
  });
  it.each([
    "apps/web/src/new.ts",
    "apps/web/vite.config.ts",
    "pnpm-lock.yaml",
    "scripts/generator/new.ts",
    "apps/mcp-apps/new.ts",
    "packages/shared/new.ts",
    "apps/web/src/routeTree.gen.ts",
  ])("invalidates changed build input %s", (file) => {
    const { root, put } = fixture();
    writeWebBuildProvenance(root);
    put(file, "new content");
    expect(webBuildNeedsBuild(root)).toBe(true);
  });
  it("invalidates edited and deleted ignored generated source", () => {
    const { root, put } = fixture();
    put("apps/web/src/routeTree.gen.ts", "generated one");
    writeWebBuildProvenance(root);
    put("apps/web/src/routeTree.gen.ts", "generated two");
    expect(webBuildNeedsBuild(root)).toBe(true);
    writeWebBuildProvenance(root);
    rmSync(path.join(root, "apps/web/src/routeTree.gen.ts"));
    expect(webBuildNeedsBuild(root)).toBe(true);
  });
  it("rejects missing outputs, modified outputs, and legacy stamps even for prebuilt runs", () => {
    const { root, put } = fixture();
    expect(() => webBuildNeedsBuild(root, true)).toThrow(
      /missing-build-stamp/u,
    );
    writeWebBuildProvenance(root);
    put("apps/web/dist/client/main.js", "tampered output");
    expect(() => webBuildNeedsBuild(root, true)).toThrow(
      /build-output-changed/u,
    );
    writeWebBuildProvenance(root);
    rmSync(path.join(root, "apps/web/dist/server/index.js"));
    expect(() => webBuildNeedsBuild(root, true)).toThrow(
      /missing-build-output/u,
    );
    put("apps/web/dist/web-build-provenance.json", '{"schemaVersion":1}');
    expect(() => webBuildNeedsBuild(root, true)).toThrow(
      /invalid-build-stamp/u,
    );
  });
  it("ignores secrets, evidence, and prose while retaining a clean build's replayability distinction", () => {
    const { root, put } = fixture();
    writeWebBuildProvenance(root);
    expect(readWebBuildProvenance(root).matchesSource).toBe(true);
    put(".env.local", "TOKEN=synthetic");
    put("apps/web/.dev.vars", "TOKEN=synthetic");
    put("artifacts/synthetic.json");
    put("apps/web/src/synthetic.md");
    expect(readWebBuildProvenance(root)).toMatchObject({
      sourceFresh: true,
      matchesSource: false,
    });
  });
  it("treats docs the in-app docs route bundles as source", () => {
    const { root, put } = fixture();
    writeWebBuildProvenance(root);
    put("docs/synthetic.md");
    expect(readWebBuildProvenance(root).details.reason).toBe("source-changed");
  });
});

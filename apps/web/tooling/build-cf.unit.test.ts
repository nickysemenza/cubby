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
import { afterEach, expect, it } from "vitest";
import { watchWebBuild } from "./build-cf";
import {
  readWebBuildProvenance,
  webBuildSourceFingerprint,
  writeWebBuildProvenance,
} from "./web-build-provenance";

// Watch failures: initial current output is rebuilt twice; edits do not receive a
// stamp; concurrent edits stamp stale output; an unchanged failure loops forever.
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-watch-"));
  roots.push(root);
  const put = (file: string, text = "synthetic") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  put(".gitignore", "apps/web/dist/\npackages/wasm/\n");
  put("apps/web/src/example.ts");
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
  put("packages/wasm/recipebridge_bg.wasm");
  put("packages/wasm/browser/recipebridge_bg.wasm");
  put("packages/wasm/cookbook/recipebridge_cookbook_bg.wasm");
  const build = () => {
    const source = webBuildSourceFingerprint(root);
    put("apps/web/dist/client/main.js");
    put("apps/web/dist/server/index.js");
    writeWebBuildProvenance(root, source);
  };
  return { root, put, build };
}
it("reuses an initial fresh build then stamps the next edited source", async () => {
  const { root, put, build } = fixture();
  build();
  const controller = new AbortController();
  let builds = 0;
  const watch = watchWebBuild(
    root,
    () => {
      builds++;
      build();
      controller.abort();
    },
    { intervalMs: 5, signal: controller.signal },
  );
  expect(builds).toBe(0);
  put("apps/web/src/example.ts", "next source");
  await watch;
  expect(builds).toBe(1);
  expect(readWebBuildProvenance(root).sourceFresh).toBe(true);
});
it("rejects a concurrent source edit and recovers on the following watch build", async () => {
  const { root, put, build } = fixture();
  const controller = new AbortController();
  const errors: string[] = [];
  let missingRejectedStamp = false;
  let builds = 0;
  await watchWebBuild(
    root,
    () => {
      builds++;
      if (builds === 1) {
        const source = webBuildSourceFingerprint(root);
        put("apps/web/dist/client/main.js");
        put("apps/web/dist/server/index.js");
        put("apps/web/src/example.ts", "edited while compiling");
        missingRejectedStamp = !existsSync(
          path.join(root, "apps/web/dist/web-build-provenance.json"),
        );
        writeWebBuildProvenance(root, source);
      }
      build();
      controller.abort();
    },
    {
      intervalMs: 5,
      signal: controller.signal,
      onError: (error) => errors.push(String(error)),
    },
  );
  expect(builds).toBe(2);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/source changed/iu);
  expect(missingRejectedStamp).toBe(true);
  expect(readWebBuildProvenance(root).sourceFresh).toBe(true);
});
it("waits for a source edit after an unchanged failed build", async () => {
  const { root } = fixture();
  const controller = new AbortController();
  let builds = 0;
  const timer = setTimeout(() => controller.abort(), 40);
  await watchWebBuild(
    root,
    () => {
      builds++;
      throw new Error("synthetic compiler error");
    },
    { intervalMs: 5, signal: controller.signal, onError: () => {} },
  );
  clearTimeout(timer);
  expect(builds).toBe(1);
});

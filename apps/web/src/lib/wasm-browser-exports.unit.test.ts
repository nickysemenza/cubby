import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The browser loads the recipebridge build without the `html` feature, so an
// export only the full (Worker) build has is `undefined` in the browser — the
// `wasm` proxy reads it off a namespace and no bundler check sees it.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = path.join(ROOT, "apps/web/src");

const exportNames = (dts: string) =>
  new Set(
    [
      ...readFileSync(path.join(ROOT, dts), "utf8").matchAll(
        /^export (?:function|class) (\w+)/gm,
      ),
    ].map((match) => match[1]),
  );

const browserSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      return file === path.join(SRC, "server") ? [] : browserSourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [file]
      : [];
  });

describe("browser recipebridge build", () => {
  it("is never asked for an export only the Worker build has", () => {
    const browser = exportNames("packages/wasm/browser/recipebridge.d.ts");
    const serverOnly = [
      ...exportNames("packages/wasm/worker/recipebridge.d.ts"),
    ].filter((name) => !browser.has(name));
    expect(serverOnly).toContain("compact_browser_page");

    const pattern = new RegExp(`\\b(${serverOnly.join("|")})\\b`);
    const offenders = browserSourceFiles(SRC).flatMap((file) => {
      const match = pattern.exec(readFileSync(file, "utf8"));
      return match ? [`${path.relative(SRC, file)}: ${match[1]}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});

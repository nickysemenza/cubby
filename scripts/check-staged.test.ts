import assert from "node:assert/strict";
import test from "node:test";
import { parseStagedPaths, selectStagedFiles } from "./check-staged.ts";

test("staged paths retain names with spaces and discard the terminal separator", () => {
  assert.deepEqual(parseStagedPaths("apps/web/a file.ts\0README.md\0"), [
    "apps/web/a file.ts",
    "README.md",
  ]);
});

test("only lintable and formatter-supported staged files are selected", () => {
  assert.deepEqual(
    selectStagedFiles([
      "apps/web/src/page.tsx",
      "scripts/check.mts",
      "packages/shared/src/legacy.cjs",
      "apps/web/package.json",
      "apps/web/src/styles.css",
      "apps/web/index.html",
      "README.md",
      "pnpm-workspace.yaml",
      "apps/web/src/page.tsx",
    ]),
    {
      lintable: [
        "apps/web/src/page.tsx",
        "scripts/check.mts",
        "packages/shared/src/legacy.cjs",
      ],
      formattable: [
        "apps/web/src/page.tsx",
        "scripts/check.mts",
        "packages/shared/src/legacy.cjs",
        "apps/web/package.json",
        "apps/web/src/styles.css",
        "apps/web/index.html",
      ],
    },
  );
});

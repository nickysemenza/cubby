import assert from "node:assert/strict";
import { test } from "node:test";
import { findDeadPaths } from "./check-doc-paths.ts";

// Failure modes: a doc names a file that moved (agents then guess paths), a
// `:line`/`#anchor` suffix or a placeholder reads as a dead path, and a
// relative link resolves against the repo root instead of the doc's folder.
const known = new Set([
  "apps/web/scripts/e2e-affected.ts",
  "docs/agents/validation.md",
  "docs/local-development.md",
]);
const isKnown = (path: string) => known.has(path);

test("reports a moved repo path with its doc line", () => {
  const dead = findDeadPaths(
    [
      {
        path: "docs/agents/validation-tests.md",
        text: "intro\nsee `scripts/e2e-affected.ts` for matching\n",
      },
    ],
    isKnown,
  );
  assert.deepEqual(dead, [
    "docs/agents/validation-tests.md:2 -> scripts/e2e-affected.ts",
  ]);
});

test("accepts suffixes and skips placeholders, globs, and external links", () => {
  const dead = findDeadPaths(
    [
      {
        path: "AGENTS.md",
        text: [
          "`apps/web/scripts/e2e-affected.ts:12` and `docs/agents/validation.md#gate`",
          "`apps/web/src/**/*.ts`, `artifacts/<lane>/run.json`, `docs/${name}.md`",
          "[site](https://example.com/docs/missing.md) [here](#gate)",
        ].join("\n"),
      },
    ],
    isKnown,
  );
  assert.deepEqual(dead, []);
});

test("resolves relative links against the doc's folder", () => {
  const dead = findDeadPaths(
    [
      {
        path: "docs/agents/validation.md",
        text: "[dev](../local-development.md#native) [gone](./missing.md)",
      },
    ],
    isKnown,
  );
  assert.deepEqual(dead, [
    "docs/agents/validation.md:1 -> docs/agents/missing.md",
  ]);
});

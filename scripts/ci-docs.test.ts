import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isEditorialOnly } from "./ci-docs.ts";
import {
  playbookMarkdownFiles,
  runtimeMarkdownFiles,
} from "./lib/playbook-sources.ts";
import { digestFiles } from "./lib/tree-digest.ts";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cubby-ci-docs-"));
  roots.push(root);
  const put = (file: string, content = "synthetic") => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  put("docs/runtime.md", "[One hop only](editorial.md)");
  put("docs/editorial.md");
  put(
    ".agents/skills/purchase-import/SKILL.md",
    "[Runtime](../../../docs/runtime.md)",
  );
  put("docs/guide/synthetic.md");
  return { root, put };
}

it("routes editorial-only diffs without skipping runtime, mixed or unknown changes", () => {
  const { root } = fixture();
  expect(isEditorialOnly(root, ["AGENTS.md", "docs/development.md"])).toBe(
    true,
  );
  expect(isEditorialOnly(root, ["docs/editorial.md"])).toBe(true);
  for (const files of [
    [],
    ["docs/runtime.md"],
    ["docs/guide/deleted.md"],
    [".agents/skills/purchase-import/SKILL.md"],
    ["plugins/cubby/skills/synthetic/SKILL.md"],
    ["docs/development.md", "apps/web/src/synthetic.ts"],
    ["apps/web/src/synthetic.md"],
    [".github/workflows/ci.yaml"],
  ])
    expect(isEditorialOnly(root, files)).toBe(false);
});

it("fingerprints one-hop playbook sources and guides, not editorial prose or generated guides during generation", () => {
  const { root, put } = fixture();
  const fingerprint = () =>
    digestFiles(
      root,
      runtimeMarkdownFiles(root).map((file) => join(root, file)),
    );
  const before = fingerprint();
  put("docs/development.md", "editorial");
  put("docs/editorial.md", "two hops away");
  expect(fingerprint()).toBe(before);
  put("docs/runtime.md", "changed served text");
  expect(fingerprint()).not.toBe(before);
  const changed = fingerprint();
  put("docs/guide/new.md");
  expect(fingerprint()).not.toBe(changed);
  expect(playbookMarkdownFiles(root)).not.toContain("docs/guide/new.md");
  put("docs/new-runtime.md");
  put(
    ".agents/skills/purchase-import/SKILL.md",
    "[Runtime](../../../docs/new-runtime.md)",
  );
  expect(isEditorialOnly(root, ["docs/new-runtime.md"])).toBe(false);
  expect(playbookMarkdownFiles(root)).not.toContain("docs/runtime.md");
});

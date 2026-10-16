import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { expect, it } from "vitest";
import { corpusTemplateHash } from "./corpus-template";

function fixtureGraph(root: string): void {
  mkdirSync(join(root, "tooling/dev"), { recursive: true });
  writeFileSync(
    join(root, "tooling/dev/corpus-template.ts"),
    `import "../scenarios/corpus";`,
  );
  mkdirSync(join(root, "tooling/scenarios"), { recursive: true });
  writeFileSync(
    join(root, "tooling/scenarios/corpus.ts"),
    "export const synthetic = 1;",
  );
}

// Indirect tooling fixtures and application calculations must invalidate seeds.
it("invalidates corpus templates for tooling fixtures, src calculations and image bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-hash-"));
  try {
    fixtureGraph(root);
    for (const file of [
      "tooling/cookbook-bundle-fixture.ts",
      "tooling/product-category-fixtures.ts",
      "tooling/factories/build.ts",
      "tooling/scenarios/corpus.ts",
      "src/lib/calculation.ts",
      "src/server/domains/synthetic/repo/write.ts",
      "tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
    ]) {
      const entry = join(root, "tooling/dev/corpus-template.ts");
      if (file.endsWith(".ts") && file !== "tooling/scenarios/corpus.ts")
        writeFileSync(
          entry,
          readFileSync(entry, "utf8") + `\nimport "../../${file}";`,
        );
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "export const synthetic = 1;");
      const before = corpusTemplateHash(root);
      writeFileSync(join(root, file), "export const synthetic = 2;");
      expect(corpusTemplateHash(root)).not.toBe(before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Rendering-only edits must retain a finalized seed rather than rebuilding it.
it("retains corpus templates across unrelated UI source edits", () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-hash-ui-"));
  try {
    fixtureGraph(root);
    const before = corpusTemplateHash(root);
    for (const file of [
      "src/features/synthetic/view.tsx",
      "src/ui/synthetic.tsx",
      "src/routes/synthetic.tsx",
      "src/components/synthetic.tsx",
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(
        join(root, file),
        "export const synthetic = 'rendering-only';",
      );
    }
    expect(corpusTemplateHash(root)).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("forces a fresh corpus generation for an explicit reseed", () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-hash-reseed-"));
  try {
    fixtureGraph(root);
    expect(corpusTemplateHash(root, "synthetic-new-generation")).not.toBe(
      corpusTemplateHash(root),
    );
    expect(corpusTemplateHash(root, "synthetic-new-generation")).toBe(
      corpusTemplateHash(root, "synthetic-new-generation"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Package imports stay external in the app graph. Their runtime code and
// export maps must still invalidate the seed even without a lockfile change.
it("invalidates templates for workspace runtime sources and export manifests", () => {
  const workspace = mkdtempSync(join(tmpdir(), "cubby-hash-workspace-"));
  const root = join(workspace, "apps/web");
  try {
    fixtureGraph(root);
    writeFileSync(
      join(root, "tooling/dev/corpus-template.ts"),
      'import "@cubby/usda"; import "@cubby/worker-tracing";',
    );
    for (const file of [
      "packages/usda/src/index.ts",
      "packages/worker-tracing/src/index.ts",
      "packages/usda/package.json",
      "packages/worker-tracing/package.json",
    ]) {
      const path = join(workspace, file);
      mkdirSync(dirname(path), { recursive: true });
      const source = file.endsWith(".ts")
        ? "export const synthetic = 1;"
        : '{"exports":"./src/index.ts"}';
      writeFileSync(path, source);
      const before = corpusTemplateHash(root);
      writeFileSync(
        path,
        source.replace("1", "2").replace("index.ts", "other.ts"),
      );
      expect(corpusTemplateHash(root)).not.toBe(before);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

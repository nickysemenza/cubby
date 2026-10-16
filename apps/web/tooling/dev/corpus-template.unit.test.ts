import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { expect, it } from "vitest";
import { corpusTemplateHash } from "./corpus-template";

// Indirect tooling fixtures and application calculations must invalidate seeds.
it("invalidates corpus templates for tooling fixtures, src calculations and image bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-hash-"));
  try {
    for (const file of [
      "tooling/cookbook-bundle-fixture.ts",
      "tooling/product-category-fixtures.ts",
      "tooling/factories/build.ts",
      "tooling/scenarios/corpus.ts",
      "src/lib/calculation.ts",
      "tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
    ]) {
      const before = corpusTemplateHash(root);
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "synthetic changed input");
      expect(corpusTemplateHash(root)).not.toBe(before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

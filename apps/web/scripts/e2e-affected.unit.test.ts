import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ALL_SPECS_TRIGGERS, SPEC_AREAS } from "../tests/e2e/spec-areas.ts";
import { computeAffected, globToRegExp } from "./e2e-affected.ts";

const E2E_DIR = fileURLToPath(new URL("../tests/e2e", import.meta.url));

describe("spec-areas.ts manifest coverage", () => {
  it("has an entry for every *.spec.ts file on disk, and no entry for a missing file", () => {
    const onDisk = readdirSync(E2E_DIR)
      .filter((name) => name.endsWith(".spec.ts"))
      .sort();
    const inManifest = SPEC_AREAS.map((entry) => entry.file).sort();

    expect(inManifest).toEqual(onDisk);
    // No duplicate entries for the same spec.
    expect(new Set(inManifest).size).toBe(inManifest.length);
  });

  it("gives every entry at least one glob", () => {
    for (const entry of SPEC_AREAS) {
      expect(entry.globs.length, `${entry.file} has no globs`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("globToRegExp", () => {
  it("matches a literal path", () => {
    expect(
      globToRegExp("apps/web/package.json").test("apps/web/package.json"),
    ).toBe(true);
    expect(
      globToRegExp("apps/web/package.json").test("apps/web/other.json"),
    ).toBe(false);
  });

  it("matches a single-star segment but not a path separator", () => {
    const re = globToRegExp("apps/web/src/app/_components/form-utils*.ts*");
    expect(re.test("apps/web/src/app/_components/form-utils.tsx")).toBe(true);
    expect(
      re.test("apps/web/src/app/_components/form-utils-focus.unit.test.tsx"),
    ).toBe(true);
    expect(re.test("apps/web/src/app/_components/other/form-utils.tsx")).toBe(
      false,
    );
  });

  it("matches nested paths with a double-star", () => {
    const re = globToRegExp("apps/web/src/app/tasks/**");
    expect(re.test("apps/web/src/app/tasks/kanban-board.tsx")).toBe(true);
    expect(re.test("apps/web/src/app/tasks/nested/deep-file.ts")).toBe(true);
    expect(re.test("apps/web/src/app/projects/index.tsx")).toBe(false);
  });
});

describe("computeAffected", () => {
  it("selects the specs mapped to a changed route file", () => {
    const { specs, ranEverything } = computeAffected(
      ["apps/web/src/routes/_authenticated/tasks.index.tsx"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(false);
    expect(specs).toContain("bulk-edit.spec.ts");
    expect(specs).toContain("dnd-interactions.spec.ts");
    expect(specs).toContain("webkit.dnd-interactions.spec.ts");
    expect(specs).toContain("project-tracker.spec.ts");
    expect(specs).not.toContain("garden.spec.ts");
  });

  it("selects specs mapped to a changed feature dir", () => {
    const { specs, ranEverything } = computeAffected(
      ["apps/web/src/app/vendors/vendor-detail-view.tsx"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(false);
    expect(specs).toEqual(["entity-editor-lifecycle.spec.ts"]);
  });

  it("selects specs mapped to a changed server repo dir", () => {
    const { specs, ranEverything } = computeAffected(
      ["apps/web/src/server/repo/product-category.ts"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(false);
    expect(specs).toContain("wardrobe-preparation.spec.ts");
    expect(specs).toContain("mobile.wardrobe.spec.ts");
  });

  it("selects every spec when a harness file changes", () => {
    const { specs, ranEverything } = computeAffected(
      ["apps/web/tests/e2e/e2e-helpers.ts"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(true);
    expect(specs.length).toBe(SPEC_AREAS.length);
  });

  it("selects every importer when a shared contract file changes", () => {
    const { specs, ranEverything } = computeAffected(
      ["apps/web/tests/e2e/relationship-discovery-contract.ts"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(false);
    expect(specs).toEqual(
      [
        "mobile.relationship-discovery.spec.ts",
        "relationship-discovery.spec.ts",
      ].sort(),
    );
  });

  it("selects nothing for a docs-only change", () => {
    const { specs, ranEverything } = computeAffected(
      ["docs/todos.md"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(false);
    expect(specs).toEqual([]);
  });

  it("fails safe to every spec for an unmapped apps/web/src file", () => {
    const { specs, ranEverything, reasons } = computeAffected(
      ["apps/web/src/app/some-brand-new-feature/new-file.tsx"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(true);
    expect(specs.length).toBe(SPEC_AREAS.length);
    expect(reasons.some((reason) => reason.includes("unmapped"))).toBe(true);
  });
});

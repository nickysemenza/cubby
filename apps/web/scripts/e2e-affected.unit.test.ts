import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALL_SPECS_TRIGGERS,
  SPEC_AREAS,
  SPEC_EXTRA_GLOBS,
} from "../tests/e2e/spec-areas.ts";
import { DERIVED_SPEC_GLOBS } from "../tests/e2e/spec-areas.derived.ts";
import { computeAffected, runAffectedSpecs } from "./e2e-affected.ts";
import { deriveSpecGlobs } from "./generate-spec-areas.ts";
import {
  readWebBuildProvenance,
  writeWebBuildProvenance,
} from "../tooling/web-build-provenance";

const E2E_DIR = fileURLToPath(new URL("../tests/e2e", import.meta.url));

// Affected execution can select correct specs yet silently run stale output;
// prebuilt mode can bypass that repair; listing must remain free of builds.
it("repairs stale output before affected tests and rejects a stale prebuilt request", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-affected-build-"));
  const previous = process.env.CUBBY_E2E_PREBUILT_WEB;
  const put = (file: string, content = "synthetic") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  try {
    delete process.env.CUBBY_E2E_PREBUILT_WEB;
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
    put("apps/web/dist/client/main.js");
    put("apps/web/dist/server/index.js");
    put("packages/wasm/recipebridge_bg.wasm");
    writeWebBuildProvenance(root);
    put("apps/web/src/example.ts", "dirty edit");
    const calls: string[] = [];
    const testedFreshness: boolean[] = [];
    const testedArgs: string[][] = [];
    const execute = (_command: string, args: string[]) => {
      if (args.includes("@cubby/web:build-cf")) {
        calls.push("build");
        writeWebBuildProvenance(root);
      } else {
        calls.push("tests");
        testedFreshness.push(readWebBuildProvenance(root).sourceFresh);
        testedArgs.push(args);
      }
    };
    await runAffectedSpecs(root, ["synthetic.spec.ts"], [], execute);
    expect(calls).toEqual(["build", "tests"]);
    calls.length = 0;
    await runAffectedSpecs(root, ["synthetic.spec.ts"], [], execute);
    expect(calls).toEqual(["tests"]);
    expect(testedFreshness).toEqual([true, true]);
    expect(testedArgs.every((args) => args.includes("synthetic.spec.ts"))).toBe(
      true,
    );
    put("apps/web/src/example.ts", "another edit");
    process.env.CUBBY_E2E_PREBUILT_WEB = "1";
    calls.length = 0;
    await expect(
      runAffectedSpecs(root, ["synthetic.spec.ts"], [], execute),
    ).rejects.toThrow(/prebuilt.*source-changed/iu);
    expect(calls).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CUBBY_E2E_PREBUILT_WEB;
    else process.env.CUBBY_E2E_PREBUILT_WEB = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

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

describe("derived spec areas", () => {
  // The generated routes/feature dirs are the part of the map nobody should
  // maintain by hand: a new route or a spec visiting a new URL changes them.
  it("matches the routes the specs visit (rerun `node scripts/generate-spec-areas.ts`)", () => {
    const webDir = path.resolve(E2E_DIR, "../..");
    expect(DERIVED_SPEC_GLOBS).toEqual(deriveSpecGlobs(webDir));
  });

  it("keeps hand-written extras only for specs that exist", () => {
    expect(
      Object.keys(SPEC_EXTRA_GLOBS).filter(
        (spec) => !(spec in DERIVED_SPEC_GLOBS),
      ),
    ).toEqual([]);
  });
});

describe("computeAffected", () => {
  // Harness/config changes outside src must not silently select zero specs.
  it.each([
    "apps/web/tooling/local-workerd-harness.ts",
    "apps/web/scripts/e2e-affected.ts",
    "scripts/test-services.ts",
    "apps/web/wrangler.jsonc",
    "apps/web/tsconfig.json",
    "nx.json",
    "package.json",
  ])(
    "selects every spec for runtime or validation configuration %s",
    (file) => {
      const result = computeAffected([file]);
      expect(result.ranEverything).toBe(true);
      expect(result.specs).toHaveLength(SPEC_AREAS.length);
      expect(result.reasons.join("\n")).toContain(file);
    },
  );
  it("explains every matching file even when a previous file selected the same spec", () => {
    const result = computeAffected([
      "apps/web/src/app/vendors/one.ts",
      "apps/web/src/app/vendors/two.ts",
    ]);
    expect(result.reasons.join("\n")).toContain("vendors/two.ts");
  });
  it("selects the specs mapped to a changed route file", () => {
    const { specs, ranEverything } = computeAffected(
      ["apps/web/src/routes/_authenticated/tasks.index.tsx"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(false);
    expect(specs).toContain("bulk-edit.spec.ts");
    expect(specs).toContain("dnd-interactions.spec.ts");
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
    expect(specs).toEqual([
      "entity-editor-lifecycle.spec.ts",
      "import-order-convergence.spec.ts",
      "vendor-order-mail-review.spec.ts",
    ]);
  });

  it("selects specs mapped to a changed server repo dir", () => {
    const { specs, ranEverything } = computeAffected(
      ["apps/web/src/server/repo/product-category.ts"],
      SPEC_AREAS,
      ALL_SPECS_TRIGGERS,
    );
    expect(ranEverything).toBe(false);
    expect(specs).toContain("wardrobe-preparation.spec.ts");
    expect(specs).not.toContain("wardrobe-owner.spec.ts");
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
    expect(specs).toEqual(["relationship-discovery.spec.ts"]);
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

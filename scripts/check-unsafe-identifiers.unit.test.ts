import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { scanSource, scanSources } from "./check-unsafe-identifiers.ts";

const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/unsafe-identifiers",
);

const fixture = (name: string): string =>
  readFileSync(resolve(fixtureDirectory, name), "utf8");

describe("unsafe identifier guard", () => {
  it("rejects declarations of unsafe helpers", () => {
    const violations = scanSource(
      "unsafe-helper-declaration.txt",
      fixture("unsafe-helper-declaration.txt"),
    );

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ["unsafe-helper-declaration"],
    );
  });

  it("rejects imported unsafe helpers and calls through aliases", () => {
    const violations = scanSource(
      "unsafe-helper-import-and-call.txt",
      fixture("unsafe-helper-import-and-call.txt"),
    );

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ["unsafe-helper-import", "unsafe-helper-call"],
    );
  });

  it("rejects namespace imports and member calls", () => {
    const violations = scanSource(
      "member-and-namespace.txt",
      fixture("member-and-namespace.txt"),
    );

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ["unsafe-helper-import", "unsafe-helper-call", "unsafe-helper-call"],
    );
  });

  it("rejects production imports of the test-only identifier module", () => {
    const violations = scanSource(
      "testing-module-import.txt",
      fixture("testing-module-import.txt"),
    );

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      ["unsafe-helper-import"],
    );
  });

  it("rejects re-exports and non-static module loading bypasses", () => {
    const violations = scanSource(
      "module-bypass-imports.txt",
      fixture("module-bypass-imports.txt"),
    );

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      [
        "unsafe-helper-import",
        "unsafe-helper-import",
        "unsafe-helper-import",
        "unsafe-helper-import",
        "unsafe-helper-import",
      ],
    );
  });

  it("allows test-only module loading in test paths", () => {
    assert.deepEqual(
      scanSource(
        "src/example.unit.test.ts",
        `export * from "@cubby/schemas/testing";
const dynamicallyLoaded = import("@cubby/schemas/testing");
const required = require("@cubby/schemas/testing");
`,
      ),
      [],
    );
  });

  it("rejects branded assertions, including generic and array forms", () => {
    const violations = scanSource(
      "branded-assertions.txt",
      fixture("branded-assertions.txt"),
    );

    assert.equal(violations.length, 14);
    assert.equal(
      violations.every((violation) => violation.kind === "branded-assertion"),
      true,
    );
  });

  it("resolves branded schema outputs through imported aliases", () => {
    const violations = scanSources([
      {
        file: resolve(fixtureDirectory, "brand-provenance-source.ts"),
        source: fixture("brand-provenance-source.txt"),
      },
      {
        file: resolve(fixtureDirectory, "brand-provenance-consumer.ts"),
        source: fixture("brand-provenance-consumer.txt"),
      },
    ]);

    assert.equal(violations.length, 4);
    assert.equal(
      violations.every((violation) => violation.kind === "branded-assertion"),
      true,
    );
  });

  it("rejects computed, destructured, and indirect-module bypasses", () => {
    const violations = scanSource(
      "src/adversarial-bypasses.ts",
      fixture("adversarial-bypasses.txt"),
    );

    assert.deepEqual(
      violations.map((violation) => violation.kind),
      [
        "unsafe-helper-call",
        "unsafe-helper-declaration",
        "unsafe-helper-call",
        "unsafe-helper-import",
        "unsafe-helper-import",
      ],
    );
  });

  it("does not treat ordinary parsing or strings as violations", () => {
    assert.deepEqual(
      scanSource(
        "clean.ts",
        `const label = "unsafeProductId";\nconst value: string = input;\n`,
      ),
      [],
    );
  });

  it("does not classify unrelated protocol ids as branded entity ids", () => {
    assert.deepEqual(
      scanSource(
        "allowed-unbranded-assertion.txt",
        fixture("allowed-unbranded-assertion.txt"),
      ),
      [],
    );
  });
});

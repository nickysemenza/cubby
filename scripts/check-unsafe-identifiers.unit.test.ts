import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { scanSource } from "./check-unsafe-identifiers.ts";

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

    assert.deepEqual(violations.map((violation) => violation.kind), [
      "unsafe-helper-declaration",
    ]);
  });

  it("rejects imported unsafe helpers and calls through aliases", () => {
    const violations = scanSource(
      "unsafe-helper-import-and-call.txt",
      fixture("unsafe-helper-import-and-call.txt"),
    );

    assert.deepEqual(violations.map((violation) => violation.kind), [
      "unsafe-helper-import",
      "unsafe-helper-call",
    ]);
  });

  it("rejects namespace imports and member calls", () => {
    const violations = scanSource(
      "member-and-namespace.txt",
      fixture("member-and-namespace.txt"),
    );

    assert.deepEqual(violations.map((violation) => violation.kind), [
      "unsafe-helper-import",
      "unsafe-helper-call",
      "unsafe-helper-call",
    ]);
  });

  it("rejects production imports of the test-only identifier module", () => {
    const violations = scanSource(
      "testing-module-import.txt",
      fixture("testing-module-import.txt"),
    );

    assert.deepEqual(violations.map((violation) => violation.kind), [
      "unsafe-helper-import",
    ]);
  });

  it("rejects branded assertions, including generic and array forms", () => {
    const violations = scanSource(
      "branded-assertions.txt",
      fixture("branded-assertions.txt"),
    );

    assert.equal(violations.length, 3);
    assert.equal(
      violations.every((violation) => violation.kind === "branded-assertion"),
      true,
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

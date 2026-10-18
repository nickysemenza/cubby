import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SEEDED_RULE_REVISIONS } from "tooling/factories/base-world";
import { describe, expect, it } from "vitest";

import { AUTOMATIC_RULES } from "./automatic-rules";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../drizzle/0090_sweeps_maintenance_automatic_rules.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

// A revision bump turns a rule off until a member re-enables it, so the seeded
// rows must name the revisions the code declares.
describe("seeded Automatic rule revisions", () => {
  it("match the declared rules in the migration and the test world", () => {
    expect(Object.keys(SEEDED_RULE_REVISIONS).sort()).toEqual(
      Object.keys(AUTOMATIC_RULES).sort(),
    );
    for (const key of [
      "field.addition",
      "statement_transaction.attach",
    ] as const) {
      const revision = AUTOMATIC_RULES[key].revision();
      expect(SEEDED_RULE_REVISIONS[key]).toBe(revision);
      expect(migration).toContain(`'${key}', '${revision}'`);
    }
  });
});

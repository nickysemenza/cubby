import { describe, expect, it } from "vitest";

import {
  compareDatabaseChecks,
  REQUIRED_DATABASE_CHECKS,
  type DatabaseCheckConstraint,
} from "./db-check-contract";

const matching = (): DatabaseCheckConstraint[] =>
  REQUIRED_DATABASE_CHECKS.map((check) => ({ ...check, validated: true }));

describe("database CHECK contract", () => {
  it("accepts the exact validated firewall", () => {
    expect(compareDatabaseChecks(matching())).toEqual([]);
  });

  it.each([
    ["missing", (rows: DatabaseCheckConstraint[]) => rows.slice(1)],
    [
      "unexpected",
      (rows: DatabaseCheckConstraint[]) => [
        ...rows,
        {
          name: "Domain_rule_check",
          definition: "CHECK (true)",
          validated: true,
        },
      ],
    ],
    [
      "stale",
      (rows: DatabaseCheckConstraint[]) => [
        { ...rows[0]!, definition: "CHECK (false)" },
        ...rows.slice(1),
      ],
    ],
    [
      "unvalidated",
      (rows: DatabaseCheckConstraint[]) => [
        { ...rows[0]!, validated: false },
        ...rows.slice(1),
      ],
    ],
  ])("reports a %s contract violation", (kind, mutate) => {
    expect(compareDatabaseChecks(mutate(matching()))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind })]),
    );
  });
});

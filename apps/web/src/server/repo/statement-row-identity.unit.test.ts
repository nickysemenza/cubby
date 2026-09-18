import { describe, expect, it } from "vitest";

import { statementRowExternalId } from "./statement-row-identity";

/**
 * Frozen input/output pairs. The values are synthetic on purpose — these
 * fixtures used to be real statement rows, which put a card's last four and two
 * merchants' statement descriptors in a public repo (see AGENTS.md: test
 * fixtures count).
 *
 * Synthetic costs nothing here. What the pins protect is that the hash never
 * changes silently: alter `canonical`, `cents`, the NUL separator or the
 * payload's field order and these break, which is the regression that would
 * orphan every stored `v1:` ref. Whether the function agrees with the refs
 * already in the database is a separate question, answered once by re-deriving
 * live refs through `preview_financial_statement_import` and confirming they
 * came back `already_recorded` — a check against production data, which is
 * exactly why it does not belong in a committed fixture.
 */
const STORED = [
  {
    row: {
      source: "monarch",
      account: "Test Card® (...4242)",
      date: "2024-08-29",
      amount: -959.78,
      originalStatement: "SYNTHETIC MERCHANT ONE SAN FRANCISCO CA",
    },
    externalId:
      "v1:1c9132b7fd10ba7083d480db37d6d8a48a474cfb5846decbdcceeee8dc0cb16c",
  },
  {
    row: {
      source: "monarch",
      account: "Test Card® (...4242)",
      date: "2024-06-09",
      amount: -100,
      originalStatement: "SYNTHETIC MERCHANT TWO BOULDER CO",
    },
    externalId:
      "v1:6e35dc1fe091e6147c18c7b9fad303931712f5bf5b81b09cf3691c7309690e5c",
  },
] as const;

describe("statementRowExternalId", () => {
  it.each(STORED)(
    "reproduces the frozen ref for $row.originalStatement",
    async ({ row, externalId }) => {
      await expect(statementRowExternalId(row)).resolves.toBe(externalId);
    },
  );

  it("namespaces by source, so two providers describing one charge stay two rows", async () => {
    const [{ row, externalId }] = STORED;
    await expect(
      statementRowExternalId({ ...row, source: "copilot" }),
    ).resolves.not.toBe(externalId);
  });

  it.each([
    ["case", { account: "TEST CARD® (...4242)" }],
    [
      "repeated whitespace",
      { originalStatement: "SYNTHETIC  MERCHANT  TWO BOULDER CO" },
    ],
    [
      "surrounding whitespace",
      { originalStatement: " SYNTHETIC MERCHANT TWO BOULDER CO " },
    ],
    ["trailing-zero cents", { amount: -100.0 }],
  ] as const)("ignores %s", async (_label, patch) => {
    const [, fixture] = STORED;
    await expect(
      statementRowExternalId({ ...fixture.row, ...patch }),
    ).resolves.toBe(fixture.externalId);
  });
});

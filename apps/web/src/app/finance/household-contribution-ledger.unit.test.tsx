import type { HouseholdContributionLedgerOut } from "@cubby/schemas/household-contribution";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { HouseholdContributionLedgerReport } from "./household-contribution-ledger";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

const ledger = {
  asOf: "2026-08-23",
  parties: [
    {
      party: {
        id: testShortcode("ledgerParty", "LPY-H234"),
        kind: "household",
        name: "Household",
      },
      consumed: 60,
      initiallyOutlaid: 0,
      transfersSent: 0,
      transfersReceived: 0,
      netContribution: 0,
      position: -60,
    },
    {
      party: {
        id: testShortcode("ledgerParty", "LPY-G234"),
        kind: "guest",
        name: "Guest",
      },
      consumed: 40,
      initiallyOutlaid: 0,
      transfersSent: 40,
      transfersReceived: 0,
      netContribution: 40,
      position: 0,
    },
    {
      party: {
        id: testShortcode("ledgerParty", "LPY-M234"),
        kind: "member",
        name: "Member",
      },
      consumed: 0,
      initiallyOutlaid: 100,
      transfersSent: 0,
      transfersReceived: 40,
      netContribution: 60,
      position: 60,
    },
  ],
  unattributed: { consumption: 0, funding: 0 },
  checks: {
    expenseTotal: 100,
    consumedTotal: 100,
    fundedTotal: 100,
    transferNet: 0,
    positionNet: 0,
  },
  gaps: [
    {
      code: "partial_funders",
      amount: 10,
      targetIds: [testShortcode("expense", "EXP-TEST")],
    },
    {
      code: "transfer_evidence_one_sided",
      amount: 40,
      targetIds: [testShortcode("ledgerTransfer", "LTR-TEST")],
    },
  ],
  gapsTruncated: false,
} satisfies HouseholdContributionLedgerOut;

describe("HouseholdContributionLedgerReport", () => {
  it("keeps the whole-group total, party positions, checks, and gaps distinct", async () => {
    render(<HouseholdContributionLedgerReport data={ledger} />, {
      wrapper: harness.wrapper,
    });

    expect(await screen.findByText("Whole-group cost")).toBeVisible();
    expect(
      screen.getByText("Whole-group cost").parentElement,
    ).toHaveTextContent("$100.00");
    expect(
      screen.getByRole("heading", { name: "Household contribution by party" }),
    ).toBeVisible();

    const partyRow = screen.getAllByText("Household")[0]!.closest("tr");
    if (!(partyRow instanceof HTMLTableRowElement)) {
      throw new Error("Expected the household contribution row");
    }
    expect(within(partyRow).getByText("$60.00")).toBeVisible();
    expect(within(partyRow).getAllByText("Household")).toHaveLength(2);

    expect(screen.getByText("Transfer net")).toBeVisible();
    expect(
      screen.getByText("Transfer has evidence from only one side"),
    ).toBeVisible();
    // LTR- records used to render as plain text because they had no detail
    // route. They have one now, so the gap target links like an EXP- does.
    expect(screen.getByRole("link", { name: "LTR-TEST" })).toHaveAttribute(
      "href",
      "/ledger-transfers/LTR-TEST",
    );
    expect(screen.getByRole("link", { name: "EXP-TEST" })).toHaveAttribute(
      "href",
      "/expenses/EXP-TEST",
    );
  });
});

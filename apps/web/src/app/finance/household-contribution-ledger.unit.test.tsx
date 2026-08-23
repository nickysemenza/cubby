import type { HouseholdContributionLedgerOut } from "@cubby/schemas/household-contribution";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HouseholdContributionLedgerReport } from "./household-contribution-ledger";

const ledger = {
  asOf: "2026-08-23",
  parties: [
    {
      party: {
        key: "PER-1111",
        kind: "person",
        name: "Household person",
        household: true,
      },
      consumed: 60,
      initiallyOutlaid: 100,
      transfersSent: 0,
      transfersReceived: 40,
      netContribution: 60,
      position: 0,
    },
    {
      party: { key: "guest", kind: "person", name: "Guest", household: false },
      consumed: 40,
      initiallyOutlaid: 0,
      transfersSent: 40,
      transfersReceived: 0,
      netContribution: 40,
      position: 0,
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
      code: "transfer_evidence_one_sided",
      amount: 40,
      targetIds: ["transfer-123"],
    },
  ],
  gapsTruncated: false,
} satisfies HouseholdContributionLedgerOut;

describe("HouseholdContributionLedgerReport", () => {
  it("keeps the whole-group total, party positions, checks, and gaps distinct", () => {
    render(<HouseholdContributionLedgerReport data={ledger} />);

    expect(screen.getByText("Whole-group cost")).toBeVisible();
    expect(
      screen.getByText("Whole-group cost").parentElement,
    ).toHaveTextContent("$100.00");
    expect(
      screen.getByRole("heading", { name: "Household contribution by party" }),
    ).toBeVisible();

    const partyRow = screen.getByText("Household person").closest("tr");
    expect(partyRow).not.toBeNull();
    expect(
      within(partyRow as HTMLTableRowElement).getAllByText("$60.00"),
    ).toHaveLength(2);

    expect(screen.getByText("Transfer net")).toBeVisible();
    expect(
      screen.getByText("Transfer has evidence from only one side"),
    ).toBeVisible();
    expect(screen.getByText("transfer-123")).toBeVisible();
  });
});

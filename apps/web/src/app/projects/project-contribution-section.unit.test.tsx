import { projectContributionOut } from "@cubby/schemas/household-contribution";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProjectContributionReport } from "./project-contribution-section";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

const contribution = projectContributionOut.parse({
  projectId: "PRJ-ABCD",
  wholeGroupCost: 125,
  householdInitialExposure: 90,
  guestInitialFunding: 25,
  unattributedConsumption: 5,
  unattributedInitialFunding: 10,
  householdConsumed: 75,
  parties: [
    {
      party: {
        id: "LPY-H234",
        name: "Household",
        kind: "household",
      },
      consumed: 100,
    },
    {
      party: { id: "LPY-G234", name: "Guest", kind: "guest" },
      consumed: 25,
    },
  ],
  funders: [
    {
      party: {
        id: "LPY-H234",
        kind: "household",
        name: "Household",
      },
      initiallyFunded: 90,
    },
    {
      party: {
        id: "LPY-G234",
        kind: "guest",
        name: "Guest",
      },
      initiallyFunded: 25,
    },
  ],
  gaps: [
    {
      code: "partial_funders",
      amount: 10,
      targetIds: ["EXP-2222"],
    },
    // Aggregated: stands for many expenses, so it carries a count and no
    // targets rather than one entry per record.
    {
      code: "beneficiary_assumed_household",
      amount: 40,
      count: 3,
      targetIds: [],
    },
  ],
  gapsTruncated: false,
});

describe("ProjectContributionReport", () => {
  it("separates costs, beneficiaries, original funding, and attribution gaps", () => {
    render(<ProjectContributionReport data={contribution} />, {
      wrapper: harness.wrapper,
    });

    expect(screen.getByText("Whole-group cost")).toBeVisible();
    expect(screen.getByText("$125.00")).toBeVisible();
    expect(screen.getByText("Unattributed consumption")).toBeVisible();
    expect(screen.getByText("$5.00")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Beneficiaries" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Original funders" }),
    ).toBeVisible();
    expect(screen.getAllByText("Household")).toHaveLength(4);
    expect(screen.getAllByText("Guest")).toHaveLength(4);
    expect(
      screen.getByText(/Some original funding is unattributed/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "EXP-2222" })).toHaveAttribute(
      "href",
      "/expenses/EXP-2222",
    );
  });

  it("summarises an assumed-household gap by count instead of listing records", () => {
    render(<ProjectContributionReport data={contribution} />, {
      wrapper: harness.wrapper,
    });

    // The whole point of aggregating: one line with a count, not one link per
    // expense. Enumerating these is the wall this replaced.
    expect(
      screen.getByText(/Consumption assumed to be the household's/),
    ).toBeVisible();
    expect(screen.getByText(/across 3 expenses/)).toBeVisible();
  });
});

import { projectContributionOut } from "@cubby/schemas/household-contribution";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectContributionReport } from "./project-contribution-section";

const contribution = projectContributionOut.parse({
  projectId: "PRJ-ABCD",
  wholeGroupCost: 125,
  householdInitialExposure: 90,
  guestInitialFunding: 25,
  unattributedInitialFunding: 10,
  householdConsumed: 75,
  people: [
    {
      personId: "PER-ABCD",
      name: "Household person",
      kind: "household",
      consumed: 100,
    },
    { personId: "PER-EFGH", name: "Guest", kind: "guest", consumed: 25 },
  ],
  funders: [
    {
      party: {
        key: "joint",
        kind: "shared_fund",
        name: "Joint checking",
        household: true,
      },
      initiallyFunded: 90,
    },
    {
      party: {
        key: "PER-EFGH",
        kind: "person",
        name: "Guest",
        household: false,
      },
      initiallyFunded: 25,
    },
  ],
  gaps: ["partial_funders: EXP-1111"],
});

describe("ProjectContributionReport", () => {
  it("separates costs, beneficiaries, original funding, and attribution gaps", () => {
    render(<ProjectContributionReport data={contribution} />);

    expect(screen.getByText("Whole-group cost")).toBeVisible();
    expect(screen.getByText("$125.00")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Beneficiaries" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Original funders" }),
    ).toBeVisible();
    expect(screen.getByText("Household")).toBeVisible();
    expect(screen.getByText("Shared")).toBeVisible();
    expect(screen.getAllByText("Guest")).toHaveLength(3);
    expect(screen.getByText("Joint checking")).toBeVisible();
    expect(screen.getByText("partial_funders: EXP-1111")).toBeVisible();
  });
});

import { projectContributionOut } from "@cubby/schemas/household-contribution";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProjectContributionReport } from "./project-contribution-section";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    params,
    to,
  }: {
    children: ReactNode;
    className?: string;
    params: { shortcode: string };
    to: string;
  }) => (
    <a className={className} href={to.replace("$shortcode", params.shortcode)}>
      {children}
    </a>
  ),
}));

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
  ],
});

describe("ProjectContributionReport", () => {
  it("separates costs, beneficiaries, original funding, and attribution gaps", () => {
    render(<ProjectContributionReport data={contribution} />);

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
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileCard } from "./mobile-card";

/**
 * The regression that prompted this: a row declared six values and rendered
 * two, with nothing indicating which four were missing.
 *
 * The card now shows a reading budget and discloses the remainder with a
 * counted control — so the original guarantee (nothing vanishes unannounced)
 * still holds, by a different mechanism than "render all six always", which
 * ran cards to ~490px and under two records a screen.
 */
const SIX = [
  { id: "costType", label: "Cost Type", value: "Services" },
  { id: "project", label: "Project", value: "<project>" },
  { id: "product", label: "Product", value: "<product>" },
  { id: "future", label: "Planned", value: "Yes" },
  { id: "trade", label: "Trade", value: "Arts & Crafts" },
  { id: "vendor", label: "Vendor", value: "<vendor>" },
];

const BUDGET = 3;

describe("MobileCard row variant", () => {
  it("holds values back only behind a control that counts them", () => {
    render(<MobileCard variant="row" title="<record>" metaValues={SIX} />);

    // The budget is what the card rests at.
    expect(screen.getAllByRole("term")).toHaveLength(BUDGET);
    // …and the overflow is stated, not silent. This is the whole reason a
    // fixed cap was reverted before: four values disappeared with no cue.
    const more = screen.getByRole("button", {
      name: `+${SIX.length - BUDGET} more`,
    });

    fireEvent.click(more);

    // Expanded, the original guarantee holds: every declared value is present.
    for (const item of SIX) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
      expect(screen.getByText(String(item.value))).toBeInTheDocument();
    }
    expect(screen.getAllByRole("term")).toHaveLength(SIX.length);
  });

  it("renders no disclosure when everything fits the budget", () => {
    render(<MobileCard variant="row" title="t" metaValues={SIX.slice(0, 2)} />);
    expect(screen.getAllByRole("term")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("labels each visible value so it stays self-identifying", () => {
    render(<MobileCard variant="row" title="t" metaValues={SIX} />);
    // Labels are <dt>, values <dd> — a description list, not loose chips.
    expect(screen.getAllByRole("term")).toHaveLength(BUDGET);
    expect(screen.getAllByRole("definition")).toHaveLength(BUDGET);
  });

  it("renders no spec grid when a row has no metadata", () => {
    render(<MobileCard variant="row" title="whole peanuts" subtitle="food" />);
    expect(screen.queryAllByRole("term")).toHaveLength(0);
    expect(screen.getByText("food")).toBeInTheDocument();
  });

  it("keeps trailing values on the identity line", () => {
    render(
      <MobileCard
        variant="row"
        title="t"
        subtitle="Jun 3, 2027"
        rightValues={["$1,000.00"]}
        metaValues={SIX}
      />,
    );
    // The headline number is NOT a labeled spec row — it stays right-aligned
    // on the identity line so it scans as a column down the list.
    expect(screen.getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.getAllByRole("term")).toHaveLength(BUDGET);
  });
});

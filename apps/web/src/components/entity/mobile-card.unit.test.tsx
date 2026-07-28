import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileCard } from "./mobile-card";

/**
 * The regression that prompted this: a row declared six values and rendered
 * two, with nothing indicating which four were missing.
 */
const SIX = [
  { id: "costType", label: "Cost Type", value: "Services" },
  { id: "project", label: "Project", value: "Wedding: Italy" },
  { id: "product", label: "Product", value: "Tripod" },
  { id: "future", label: "Planned", value: "Yes" },
  { id: "trade", label: "Trade", value: "Arts & Crafts" },
  { id: "vendor", label: "Vendor", value: "B&H" },
];

describe("MobileCard row variant", () => {
  it("renders every metadata value, not a capped subset", () => {
    render(
      <MobileCard variant="row" title="wedding photo 3/3" metaValues={SIX} />,
    );
    for (const item of SIX) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
      expect(screen.getByText(String(item.value))).toBeInTheDocument();
    }
  });

  it("labels each value so it stays self-identifying", () => {
    render(<MobileCard variant="row" title="t" metaValues={SIX} />);
    // Labels are <dt>, values <dd> — a description list, not loose chips.
    expect(screen.getAllByRole("term")).toHaveLength(SIX.length);
    expect(screen.getAllByRole("definition")).toHaveLength(SIX.length);
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
    expect(screen.getAllByRole("term")).toHaveLength(SIX.length);
  });
});

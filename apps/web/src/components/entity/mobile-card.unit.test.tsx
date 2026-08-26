import { fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { MobileCard } from "./mobile-card";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
}));

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

describe.each(["row", "card"] as const)(
  "MobileCard %s keyboard activation",
  (variant) => {
    it.each(["Enter", " "])("activates with %j", (key) => {
      const onClick = vi.fn();
      render(<MobileCard variant={variant} title="Item" onClick={onClick} />);

      const title = screen.getByRole("button", { name: "Item" });
      fireEvent.keyDown(title, { key });
      fireEvent.click(title);

      expect(onClick).toHaveBeenCalledOnce();
      expect(title).toHaveClass("min-h-11");
      if (variant === "row") {
        expect(screen.getByRole("group")).toHaveClass("min-h-11");
      }
    });

    it("does not treat a nested control's keypress as card activation", () => {
      const onClick = vi.fn();
      render(
        <MobileCard
          variant={variant}
          title="Item"
          onClick={onClick}
          actions={<button type="button">Edit</button>}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      expect(onClick).not.toHaveBeenCalled();
    });
  },
);

it("gives a canonical detail title a full phone touch target", () => {
  render(<MobileCard variant="row" title="Item" detailsHref="/products/one" />);

  expect(screen.getByRole("link", { name: "Item" })).toHaveClass("min-h-11");
});

describe("MobileCard interactive row semantics", () => {
  it("keeps selection and row actions as valid siblings of the title control", () => {
    render(
      <MobileCard
        variant="row"
        title="Expense"
        onClick={vi.fn()}
        selectable={{ isSelected: false, onSelectionChange: vi.fn() }}
        actions={<button type="button">More actions</button>}
      />,
    );

    const group = screen.getByRole("group");
    expect(group).toContainElement(screen.getByRole("checkbox"));
    expect(group).toContainElement(
      screen.getByRole("button", { name: "Expense" }),
    );
    expect(group).toContainElement(
      screen.getByRole("button", { name: "More actions" }),
    );
    expect(screen.queryByRole("button", { name: "Expense" })).not.toBeNull();
  });
});

import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  HierarchyDrilldown,
  type HierarchyDrilldownNode,
} from "./hierarchy-drilldown";

// The drilldown's contract is the location destination, not router setup. The
// app integration supplies TanStack Router; this keeps the shared UI focused.
interface MockLinkProps extends Omit<ComponentProps<"a">, "children" | "href"> {
  to: string;
  params: { shortcode: string };
  children: ReactNode;
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: MockLinkProps) => (
    <a href={to.replace("$shortcode", params.shortcode)} {...props}>
      {children}
    </a>
  ),
}));

const workshop = unsafeLocationShortcode("LOC-WRKS");
const upperZone = unsafeLocationShortcode("LOC-UPPR");
const utilityRoom = unsafeLocationShortcode("LOC-UTIL");

const tree: HierarchyDrilldownNode = {
  id: "home",
  label: "Home",
  metricLabel: "12 each",
  metricValue: 12,
  children: [
    {
      id: "utility-room",
      label: "Utility Room",
      metricLabel: "2 each",
      metricValue: 2,
      locationShortcode: utilityRoom,
    },
    {
      id: "workshop",
      label: "Workshop",
      metricLabel: "10 each",
      metricValue: 10,
      locationShortcode: workshop,
      children: [
        {
          id: "upper-zone",
          label: "Upper Zone",
          metricLabel: "7 each",
          metricValue: 7,
          locationShortcode: upperZone,
          annotations: ["installed"],
        },
      ],
      directMetricLabel: "3 each",
      directMetricValue: 3,
    },
  ],
};

function renderDrilldown(root = tree) {
  return render(
    <HierarchyDrilldown root={root} ariaLabel="Product locations" />,
  );
}

describe("HierarchyDrilldown", () => {
  it("sorts total metrics descending and drills through breadcrumbs and Back", () => {
    renderDrilldown();

    const breakdown = screen.getByRole("list", { name: "Home breakdown" });
    expect(
      within(breakdown)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Workshop"),
      expect.stringContaining("Utility Room"),
    ]);

    const drill = screen.getByRole("button", { name: /drill into workshop/i });
    expect(drill).toHaveAttribute("type", "button");
    fireEvent.click(drill);

    expect(screen.getByText("Upper Zone")).toBeInTheDocument();
    expect(screen.getByText("Directly here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(
      screen.getByRole("list", { name: "Home breakdown" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /drill into workshop/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("list", { name: "Home breakdown" }),
    ).toBeInTheDocument();
  });

  it("uses native buttons for drill controls and exposes complete metric names", () => {
    renderDrilldown();

    const drill = screen.getByRole("button", {
      name: "Drill into Workshop: 10 each",
    });
    expect(drill.tagName).toBe("BUTTON");
    expect(screen.getByLabelText("Workshop: 10 each")).toBeInTheDocument();

    fireEvent.click(drill);
    expect(screen.getByLabelText("Directly here: 3 each")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Upper Zone: 7 each, installed"),
    ).toBeInTheDocument();
  });

  it("links leaf rows to their typed location", () => {
    renderDrilldown();

    expect(
      screen.getByRole("link", {
        name: /open location utility room: 2 each/i,
      }),
    ).toHaveAttribute("href", `/locations/${utilityRoom}`);
  });

  it("omits proportional bars when a sibling level uses incomparable values", () => {
    renderDrilldown({
      id: "mixed",
      label: "Mixed",
      metricLabel: "2 each · 100 g",
      metricValue: null,
      children: [
        {
          id: "count",
          label: "Count",
          metricLabel: "2 each",
          metricValue: null,
        },
        {
          id: "weight",
          label: "Weight",
          metricLabel: "100 g",
          metricValue: null,
        },
      ],
    });

    expect(screen.getByText("2 each")).toBeInTheDocument();
    expect(screen.getByText("100 g")).toBeInTheDocument();
    expect(
      document.querySelectorAll('[aria-hidden="true"][style*="width"]').length,
    ).toBe(0);
  });

  it("still gives a root with only direct contribution a useful row", () => {
    renderDrilldown({
      id: "workshop",
      label: "Workshop",
      metricLabel: "4 each",
      metricValue: 4,
      directMetricLabel: "4 each",
      directMetricValue: 4,
    });

    expect(screen.getByText("Directly here")).toBeInTheDocument();
    expect(screen.getByLabelText("Directly here: 4 each")).toBeInTheDocument();
  });

  it("keeps the focused branch live when refreshed data replaces the tree", () => {
    const view = renderDrilldown();
    fireEvent.click(
      screen.getByRole("button", { name: /drill into workshop/i }),
    );

    view.rerender(
      <HierarchyDrilldown
        ariaLabel="Product locations"
        root={{
          ...tree,
          metricLabel: "13 each",
          metricValue: 13,
          children: tree.children?.map((node) =>
            node.label === "Workshop"
              ? {
                  ...node,
                  metricLabel: "11 each",
                  metricValue: 11,
                  directMetricLabel: "4 each",
                  directMetricValue: 4,
                }
              : node,
          ),
        }}
      />,
    );

    expect(screen.getByText("11 each")).toBeInTheDocument();
    expect(screen.getByLabelText("Directly here: 4 each")).toBeInTheDocument();
  });
});

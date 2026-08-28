import { testShortcode } from "@cubby/schemas/testing";
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

const workshop = testShortcode("location", "LOC-WRKS");
const upperZone = testShortcode("location", "LOC-UPPR");
const utilityRoom = testShortcode("location", "LOC-UTIL");

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
    expect(within(drill).getByText("10 each")).toBeInTheDocument();
    expect(screen.getByText("Workshop")).toHaveAttribute("title", "Workshop");

    fireEvent.click(drill);
    const workshopBreakdown = screen.getByRole("list", {
      name: "Workshop breakdown",
    });
    expect(within(workshopBreakdown).getByText("3 each")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Open location Upper Zone: 7 each, installed",
      }),
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

  it("sizes contribution bars against the focused total", () => {
    renderDrilldown();

    const workshopRow = screen.getByText("Workshop").closest("li");
    const utilityRow = screen.getByText("Utility Room").closest("li");

    expect(
      workshopRow?.querySelector('[data-slot="contribution-bar"]'),
    ).toHaveStyle({ width: `${(10 / 12) * 100}%` });
    expect(
      utilityRow?.querySelector('[data-slot="contribution-bar"]'),
    ).toHaveStyle({ width: `${(2 / 12) * 100}%` });
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
      document.querySelectorAll('[data-slot="contribution-bar"]').length,
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
    expect(
      within(
        screen.getByRole("list", { name: "Workshop breakdown" }),
      ).getByText("4 each"),
    ).toBeInTheDocument();
  });

  it("marks each rung with its own thumbnail and leaves the rest on icons", () => {
    const withImages: HierarchyDrilldownNode = {
      ...tree,
      displayImage: { url: "https://img.test/home.jpg" },
      children: [
        {
          ...tree.children![0]!,
          displayImage: { url: "https://img.test/utility.jpg" },
        },
        tree.children![1]!,
      ],
    };
    const { container } = renderDrilldown(withImages);

    const sources = [...container.querySelectorAll("img")].map((img) =>
      img.getAttribute("src"),
    );
    // The focused root's mark rides on its breadcrumb rung and on the
    // "Directly here" row it synthesizes; the Workshop row has no image and
    // must not borrow one.
    expect(sources.some((src) => src?.includes("utility.jpg"))).toBe(true);
    expect(sources.some((src) => src?.includes("home.jpg"))).toBe(true);
    expect(sources).toHaveLength(2);

    // The box is reserved either way, so the imageless row still aligns.
    expect(
      within(
        screen.getByRole("button", { name: /Drill into Workshop/ }),
      ).queryByRole("img"),
    ).toBeNull();
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
    expect(
      within(
        screen.getByRole("list", { name: "Workshop breakdown" }),
      ).getByText("4 each"),
    ).toBeInTheDocument();
  });
});

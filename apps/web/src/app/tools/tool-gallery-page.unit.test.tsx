import type {
  ToolGalleryInventoryEntryOut,
  ToolGalleryItemOut,
  ToolGalleryOut,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { project } from "../projects/project.functions";
import {
  ToolCard,
  ToolGalleryPage,
  ToolInspectorSummary,
  toolLocationPath,
  toolPlacementSummary,
} from "./tool-gallery-page";

const PRODUCT_ID = testShortcode("product", "PRD-TOOLS");
const GARAGE_ID = testShortcode("location", "LOC-GARAGE");
const WORKSHOP_ID = testShortcode("location", "LOC-WORK");

const placement = (
  suffix: string,
  locationId: ToolGalleryInventoryEntryOut["location"]["id"],
  name: string,
  amount: ToolGalleryInventoryEntryOut["amount"],
  installed = false,
): ToolGalleryInventoryEntryOut => ({
  id: testShortcode("inventory", `INV-${suffix}`),
  amount,
  placement: installed ? "installed" : "stock",
  location: {
    id: locationId,
    name,
    ancestors: [
      {
        id: testShortcode("location", "LOC-HOME"),
        name: "Home",
        type: "house",
      },
    ],
  },
});

const entries = [
  placement("GAR", GARAGE_ID, "Garage", { value: 1, unit: "each" }),
  placement("WORK", WORKSHOP_ID, "Workshop", { value: 2, unit: "foot" }, true),
];

const item: ToolGalleryItemOut = {
  productId: PRODUCT_ID,
  productName: "Cordless drill",
  manufacturer: "Makita",
  model: "XFD10",
  coverImageUrl: null,
  extraImageCount: 2,
  inventoryEntries: entries,
  trade: "electrical",
  groupKey: "__multiple_locations__",
  groupLabel: "Multiple locations",
  projectUseCount: 3,
  netLifetimeCost: 240,
  costPerProjectUse: 80,
  grossLifetimeAcquisitionCost: 240,
};

const response: ToolGalleryOut = {
  meta: { pageIndex: 0, pageSize: 60, totalCount: 1 },
  items: [item],
  groups: [
    {
      key: "__multiple_locations__",
      label: "Multiple locations",
      itemCount: 1,
      startIndex: 0,
    },
  ],
  totals: { products: 1, placements: 2 },
};

let harness: ReturnType<typeof createBrowserTestHarness>;

class TestIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
  vi.unstubAllGlobals();
});

function renderGallery(
  data: ToolGalleryOut | Error,
  props: Partial<React.ComponentProps<typeof ToolGalleryPage>> = {},
) {
  return render(
    <ToolGalleryPage
      query=""
      groupBy="location"
      onQueryChange={vi.fn()}
      onGroupByChange={vi.fn()}
      onSectionChange={vi.fn()}
      operations={{
        gallery: project.toolGallery.withTransport(async () => {
          if (data instanceof Error) throw data;
          return data;
        }),
      }}
      {...props}
    />,
    { wrapper: harness.wrapper },
  );
}

describe("Tools gallery", () => {
  it("shows the gallery loading workplane while inventory is pending", () => {
    render(
      <ToolGalleryPage
        query=""
        groupBy="location"
        onQueryChange={vi.fn()}
        onGroupByChange={vi.fn()}
        onSectionChange={vi.fn()}
        operations={{
          gallery: project.toolGallery.withTransport(
            () => new Promise<ToolGalleryOut>(() => undefined),
          ),
        }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByLabelText("Loading tool gallery")).toBeVisible();
  });

  it("renders missing-image, multiple-placement, installed, and economics states", async () => {
    renderGallery(response);

    expect(
      await screen.findByRole("heading", { name: "Multiple locations" }),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "Cordless drill" })).toBeVisible();
    expect(screen.getByText("Installed")).toBeVisible();
    expect(screen.getByText("2 placements · Mixed amounts")).toBeVisible();
    expect(screen.getByText("3 project uses")).toBeVisible();
    expect(screen.getByText("$80.00/use")).toBeVisible();
    expect(screen.getByText("+2")).toBeVisible();
    expect(screen.getByText("1 tools · 2 placements")).toBeVisible();
  });

  it("owns URL-driven search and grouping while distinguishing empty states", async () => {
    const onQueryChange = vi.fn();
    const onGroupByChange = vi.fn();
    renderGallery(
      {
        ...response,
        items: [],
        groups: [],
        totals: { products: 0, placements: 0 },
      },
      { query: "router", onQueryChange, onGroupByChange },
    );

    expect(await screen.findByText("No matching tools")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "trade" },
    });
    expect(onGroupByChange).toHaveBeenCalledWith("trade");

    const search = screen.getByRole("textbox", {
      name: "Search inventoried tools",
    });
    fireEvent.change(search, { target: { value: "drill" } });
    await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith("drill"));
  });

  it("offers a retry when the gallery query fails", async () => {
    renderGallery(new Error("Gallery unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gallery unavailable",
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeVisible();
  });

  it("renders direct section jumps for compact group rosters", async () => {
    const onSectionChange = vi.fn();
    renderGallery(
      {
        ...response,
        groups: [
          ...response.groups,
          { key: "garage", label: "Garage", itemCount: 4, startIndex: 1 },
        ],
      },
      { onSectionChange },
    );

    const garageJump = (await screen.findByText("Garage")).closest("button");
    if (!garageJump) throw new Error("Garage jump button was not rendered");
    fireEvent.click(garageJump);
    expect(onSectionChange).toHaveBeenCalledWith("garage");
  });

  it("reuses the searchable filter picker for long group rosters", async () => {
    const onSectionChange = vi.fn();
    const manufacturerGroups = Array.from({ length: 11 }, (_, index) => ({
      key: `maker-${index}`,
      label: `Maker ${index}`,
      itemCount: index + 1,
      startIndex: index,
    }));
    renderGallery(
      {
        ...response,
        items: [{ ...item, groupKey: "maker-0", groupLabel: "Maker 0" }],
        groups: manufacturerGroups,
      },
      { groupBy: "manufacturer", onSectionChange },
    );

    const picker = await screen.findByRole("combobox", {
      name: "Jump to manufacturer",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open Choose a manufacturer" }),
    );
    fireEvent.change(picker, { target: { value: "Maker 10" } });
    fireEvent.click(await screen.findByRole("option", { name: /maker 10/i }));
    expect(onSectionChange).toHaveBeenCalledWith("maker-10");
  });

  it("formats every placement without summing incompatible units", () => {
    expect(toolLocationPath(entries[0]!)).toBe("Home / Garage");
    expect(toolPlacementSummary(entries)).toEqual({
      label: "2 placements · Mixed amounts",
      mixed: true,
      installed: true,
    });
  });

  it("wires the complete card as a keyboard-native inspection target", () => {
    const inspect = vi.fn();
    render(
      <ToolCard
        item={item}
        current={false}
        onInspect={inspect}
        onHover={vi.fn()}
        onHoverEnd={vi.fn()}
      />,
    );
    const card = screen.getByRole("button", { name: /cordless drill/i });
    fireEvent.click(card);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("keeps compact identity and badges while moving placement amounts and usage into inspection", () => {
    const inspect = vi.fn();
    const rendered = render(
      <ToolCard
        item={item}
        compact
        current
        onInspect={inspect}
        onHover={vi.fn()}
        onHoverEnd={vi.fn()}
      />,
    );
    const card = screen.getByRole("button", { name: /cordless drill/i });
    expect(card).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Makita · XFD10")).toBeVisible();
    expect(screen.getByText("2 placements")).toBeVisible();
    expect(screen.getByText("Installed")).toBeVisible();
    expect(screen.getByText("+2")).toBeVisible();
    expect(screen.queryByText("Home / Garage")).not.toBeInTheDocument();
    expect(screen.queryByText("3 project uses")).not.toBeInTheDocument();
    expect(screen.queryByText("$80.00/use")).not.toBeInTheDocument();
    fireEvent.click(card);
    expect(inspect).toHaveBeenCalledOnce();

    rendered.rerender(<ToolInspectorSummary item={item} />);
    expect(screen.getByText("Home / Garage")).toBeVisible();
    expect(screen.getByText("Home / Workshop")).toBeVisible();
    expect(screen.getByText("3 project uses")).toBeVisible();
    expect(screen.getByText("$80.00/use")).toBeVisible();
  });
});

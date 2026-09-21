import type {
  ToolGalleryInventoryEntryOut,
  ToolGalleryItemOut,
  ToolGalleryOut,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
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
      {
        query: "router",
        presentation: "flow",
        onQueryChange,
        onGroupByChange,
      },
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
    let attempts = 0;
    renderGallery(response, {
      presentation: "flow",
      operations: {
        gallery: project.toolGallery.withTransport(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Gallery unavailable");
          return response;
        }),
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gallery unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(
      await screen.findByRole("heading", { name: "Multiple locations" }),
    ).toBeVisible();
    expect(screen.getByTestId("grouped-flow")).toBeVisible();
    expect(attempts).toBe(2);
  });

  it("renders one Flow divider for a group split across pages and associates every card with it", async () => {
    const flowItem = (
      suffix: string,
      groupKey: string,
      groupLabel: string,
    ): ToolGalleryItemOut => ({
      ...item,
      productId: testShortcode("product", `PRD-${suffix}`),
      productName: `Flow tool ${suffix}`,
      groupKey,
      groupLabel,
    });
    const groups = [
      { key: "alpha", label: "Alpha", itemCount: 59, startIndex: 0 },
      { key: "split", label: "Split group", itemCount: 2, startIndex: 59 },
      { key: "late", label: "Late group", itemCount: 1, startIndex: 61 },
    ];
    const firstPage: ToolGalleryOut = {
      meta: { pageIndex: 0, pageSize: 60, totalCount: 62 },
      items: [
        flowItem("ALPHA", "alpha", "Alpha"),
        flowItem("SPLIT1", "split", "Split group"),
      ],
      groups,
      totals: { products: 62, placements: 62 },
    };
    const secondPage: ToolGalleryOut = {
      ...firstPage,
      meta: { ...firstPage.meta, pageIndex: 1 },
      items: [
        flowItem("SPLIT2", "split", "Split group"),
        flowItem("LATE", "late", "Late group"),
      ],
    };
    const transport = vi.fn(
      async ({ input }: { input: { pagination: { pageIndex: number } } }) =>
        input.pagination.pageIndex === 0 ? firstPage : secondPage,
    );

    renderGallery(firstPage, {
      presentation: "flow",
      section: "late",
      operations: {
        gallery: project.toolGallery.withTransport(transport),
      },
    });

    expect(
      await screen.findByRole("heading", { name: "Late group" }),
    ).toBeVisible();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      screen.getAllByRole("heading", { name: "Split group" }),
    ).toHaveLength(1);
    const splitDivider = document.querySelector(
      '[data-grouped-flow-group="split"]',
    );
    if (!(splitDivider instanceof HTMLElement)) {
      throw new Error("Split Flow divider was not rendered");
    }
    expect(within(splitDivider).getByText("2")).toBeVisible();
    for (const name of ["Flow tool SPLIT1", "Flow tool SPLIT2"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(name) }),
      ).toHaveAttribute("aria-describedby", "grouped-flow-group-split-heading");
    }
  });

  it("does not repeat a handled section jump when refreshed data adds a group", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    let result = response;
    renderGallery(response, {
      presentation: "flow",
      section: item.groupKey,
      operations: {
        gallery: project.toolGallery.withTransport(async () => result),
      },
    });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    result = {
      ...response,
      meta: { ...response.meta, totalCount: 2 },
      totals: { products: 2, placements: 4 },
      items: [
        item,
        {
          ...item,
          productId: testShortcode("product", "PRD-EXTRA"),
          groupKey: "extra",
          groupLabel: "Extra tools",
        },
      ],
      groups: [
        ...response.groups,
        { key: "extra", label: "Extra tools", itemCount: 1, startIndex: 1 },
      ],
    };
    await act(() =>
      invalidateOperationTags(harness.queryClient, entityRipple("product")),
    );
    await screen.findByRole("heading", { name: "Extra tools" });
    // Section scrolling settles after two frames. Adding data must not behave
    // like switching layout and send someone back to an earlier jump target.
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockRestore();
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

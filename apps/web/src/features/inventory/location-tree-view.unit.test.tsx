import type { ImageOut } from "@cubby/schemas/image";
import { imageOut } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sampleLocations } from "~/features/design/data/samples";
import { location } from "~/integrations/tanstack-query/generated/catalog.gen";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import LocationTreeView, { LocationTree } from "./location-tree-view";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

function renderTree(tree: React.ReactNode) {
  return render(tree, { wrapper: harness.wrapper });
}

const FLOUR_ID = testShortcode("inventory", "INV-FLOUR");
const RICE_ID = testShortcode("inventory", "INV-RICE");

const kitchenImage: ImageOut = imageOut.parse({
  id: testShortcode("image", "IMG-KITCHEN"),
  url: "https://example.test/kitchen.jpg",
  key: "kitchen.jpg",
  filename: "kitchen.jpg",
  size: 100,
  contentType: "image/jpeg",
  status: "UPLOADED",
  useOriginal: false,
  width: 800,
  height: 600,
  detectedContentType: null,
  sha256: null,
  renderStatus: null,
  storageStatus: null,
  source: "unknown",
  sourcePageUrl: null,
  sourceAssetUrl: null,
  sourceName: null,
  verifiedAt: null,
  capturedAt: null,
  capturedAtOffsetMinutes: null,
  captureLocation: null,
  capturePlaceName: null,
  captureDeviceLabel: null,
  capturedByPartyId: null,
  capturedByName: null,
  captureAttribution: "none",
  provenanceEvidence: null,
  sourceEvidence: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

function treeData(): InfLocation[] {
  const kitchen = sampleLocations.find(
    (location) => location.name === "Kitchen",
  );
  const garage = sampleLocations.find((location) => location.name === "Garage");
  const pantry = kitchen?.children?.find(
    (location) => location.name === "Pantry",
  );
  if (!kitchen || !garage || !pantry) {
    throw new Error("location demo fixture is incomplete");
  }

  return [
    {
      ...kitchen,
      images: [kitchenImage],
      directItemCount: 1,
      totalItemCount: 2,
      inventoryItems: [
        {
          id: RICE_ID,
          amount: { value: 2, unit: "lb" },
          productName: "Jasmine Rice",
          productId: testShortcode("product", "PRD-RICE"),
        },
      ],
      children: [
        {
          ...pantry,
          directItemCount: 1,
          totalItemCount: 1,
          inventoryItems: [
            {
              id: FLOUR_ID,
              amount: { value: 5, unit: "lb" },
              productName: "Bread Flour",
              productId: testShortcode("product", "PRD-FLOUR"),
            },
          ],
        },
        ...(kitchen.children ?? []).filter(
          (location) => location.name !== "Pantry",
        ),
      ],
    },
    garage,
  ];
}

describe("LocationTree", () => {
  it("keeps subtree rollups when supplied tree data omits projected counts", () => {
    const [root] = treeData();
    if (!root) throw new Error("missing synthetic root");
    renderTree(
      <LocationTree
        data={[
          {
            ...root,
            directItemCount: undefined,
            totalItemCount: undefined,
            children: (root.children ?? []).map((child) => ({
              ...child,
              directItemCount: undefined,
              totalItemCount: undefined,
            })),
          },
        ]}
      />,
    );
    expect(screen.getByLabelText("1 item here, 2 total")).toHaveTextContent(
      "2",
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Kitchen" },
    });
    expect(screen.getByLabelText("1 item here, 2 total")).toHaveTextContent(
      "2",
    );
  });
  it("opens roots one level with navigable identity and labeled rollups", () => {
    const data = treeData();
    renderTree(<LocationTree data={data} />);

    expect(screen.getByRole("link", { name: "Kitchen" })).toHaveAttribute(
      "href",
      `/locations/${data[0]?.id}`,
    );
    expect(screen.queryByRole("link", { name: "Top Shelf" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "Photo of Kitchen" }),
    ).toHaveAttribute("src", kitchenImage.url);
    expect(screen.getByLabelText("1 item here, 2 total")).toHaveTextContent(
      "2",
    );

    const kitchenToggle = screen.getByRole("button", {
      name: "Collapse Kitchen",
    });
    expect(kitchenToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("supports branch and global disclosure controls", () => {
    renderTree(<LocationTree data={treeData()} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand Pantry" }));
    expect(screen.getByRole("link", { name: "Top Shelf" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Pantry" }));
    expect(
      screen.queryByRole("link", { name: "Top Shelf" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Pantry" }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(
      screen.queryByRole("link", { name: "Pantry" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("link", { name: "Top Shelf" })).toBeInTheDocument();
  });

  it("keeps inventory opt-in without resetting disclosure state", () => {
    renderTree(<LocationTree data={treeData()} />);

    expect(
      screen.queryByRole("link", { name: "Bread Flour" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show inventory" }));

    expect(screen.queryByRole("link", { name: "Jasmine Rice" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Show contents in Kitchen" }),
    );

    expect(screen.getByRole("link", { name: "Jasmine Rice" })).toHaveAttribute(
      "href",
      `/inventory/${RICE_ID}`,
    );
    expect(
      screen.queryByRole("link", { name: "Bread Flour" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Pantry" }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      screen.getByRole("button", { name: "Show contents in Pantry" }),
    );
    expect(screen.getByRole("link", { name: "Bread Flour" })).toHaveAttribute(
      "href",
      `/inventory/${FLOUR_ID}`,
    );
    expect(screen.getByText("5 lb")).toBeInTheDocument();
  });

  it("searches case-insensitively, retains ancestors, and restores expansion", () => {
    renderTree(<LocationTree data={treeData()} />);

    const search = screen.getByRole("searchbox", { name: "Find a location" });
    fireEvent.change(search, { target: { value: "TOP SHELF" } });

    expect(screen.getByRole("link", { name: "Kitchen" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pantry" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Top Shelf" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Garage" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bottom Shelf" })).toBeNull();
    fireEvent.change(search, { target: { value: "Kitchen" } });
    expect(screen.queryByRole("link", { name: "Pantry" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear tree search" }));
    expect(
      screen.queryByRole("link", { name: "Top Shelf" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Pantry" }),
    ).toBeInTheDocument();
  });

  it("searches visible inventory and explains empty results", () => {
    renderTree(<LocationTree data={treeData()} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Show inventory" }));
    const search = screen.getByRole("searchbox", {
      name: "Find a location or inventory item",
    });
    fireEvent.change(search, { target: { value: "bread flour" } });

    expect(screen.getByRole("link", { name: "Kitchen" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pantry" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Bread Flour" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Garage" }),
    ).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "nowhere" } });
    expect(screen.getByText("No matching locations")).toBeInTheDocument();
    expect(screen.getByText(/clear the search/i)).toBeInTheDocument();
  });
});

describe("location tree query lifecycle", () => {
  it("shows initial diagnostics and retries into the empty state", async () => {
    let fail = true;
    const restore = overrideStartDispatch(async () => {
      if (fail) throw new Error("SQLSTATE 08006 synthetic location tree");
      return { ok: true, data: [] };
    });
    try {
      renderTree(<LocationTreeView />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "SQLSTATE 08006 synthetic location tree",
      );
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("No locations to display.");
      expect(screen.getByText("Tree View")).toBeInTheDocument();
    } finally {
      restore();
    }
  });
  it("retains tree search and DOM through refresh failure and retry", async () => {
    harness.queryClient.setQueryData(
      location.makeTree.queryOptions().queryKey,
      treeData(),
    );
    let fail = true;
    const restore = overrideStartDispatch(async () => {
      if (fail) throw new Error("synthetic tree refresh");
      return { ok: true, data: treeData() };
    });
    try {
      renderTree(<LocationTreeView />);
      const search = screen.getByRole("searchbox");
      fireEvent.change(search, { target: { value: "Pantry" } });
      await act(async () => {
        await harness.queryClient.refetchQueries();
      });
      await screen.findByRole("alert");
      expect(screen.getByRole("searchbox")).toBe(search);
      expect(search).toHaveValue("Pantry");
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(screen.getByRole("searchbox")).toBe(search);
      expect(search).toHaveValue("Pantry");
    } finally {
      restore();
    }
  });
});

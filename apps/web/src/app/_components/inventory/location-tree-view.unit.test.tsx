import type { ImageOut } from "@cubby/schemas/image";
import { imageOut } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sampleLocations } from "~/app/docs/_data/samples";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { LocationTree } from "./location-tree-view";

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
  it("renders an expanded navigable ledger with labeled rollups", () => {
    const data = treeData();
    renderTree(<LocationTree data={data} />);

    expect(screen.getByRole("link", { name: "Kitchen" })).toHaveAttribute(
      "href",
      `/locations/${data[0]?.id}`,
    );
    expect(screen.getByRole("link", { name: "Top Shelf" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Photo of Kitchen" }),
    ).toHaveAttribute("src", kitchenImage.url);
    expect(screen.getAllByLabelText("1 item here")).toHaveLength(2);
    expect(screen.getByLabelText("2 items total")).toHaveTextContent("2 total");

    const kitchenToggle = screen.getByRole("button", {
      name: "Collapse Kitchen",
    });
    const controlledId = kitchenToggle.getAttribute("aria-controls");
    expect(kitchenToggle).toHaveAttribute("aria-expanded", "true");
    expect(controlledId).not.toBeNull();
    expect(document.getElementById(controlledId ?? "")).toBeInTheDocument();
  });

  it("supports branch and global disclosure controls", () => {
    renderTree(<LocationTree data={treeData()} />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse Pantry" }));
    expect(
      screen.queryByRole("link", { name: "Top Shelf" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Pantry" }),
    ).toHaveAttribute("aria-expanded", "false");
    const pantryContents = screen
      .getByRole("button", { name: "Expand Pantry" })
      .getAttribute("aria-controls");
    expect(document.getElementById(pantryContents ?? "")).not.toBeVisible();

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
    fireEvent.click(screen.getByRole("button", { name: "Collapse Pantry" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show inventory" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Expand Pantry" }));
    expect(screen.getByRole("link", { name: "Bread Flour" })).toHaveAttribute(
      "href",
      `/inventory/${FLOUR_ID}`,
    );
    expect(screen.getByText("5 lb")).toBeInTheDocument();
  });

  it("searches case-insensitively, retains ancestors, and restores expansion", () => {
    renderTree(<LocationTree data={treeData()} />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse Pantry" }));
    const search = screen.getByRole("searchbox", { name: "Find a location" });
    fireEvent.change(search, { target: { value: "TOP SHELF" } });

    expect(screen.getByRole("link", { name: "Kitchen" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pantry" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Top Shelf" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Garage" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pantry is expanded for search" }),
    ).toBeDisabled();

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
    expect(
      screen.getByText(/clear the search to see the whole house/i),
    ).toBeInTheDocument();
  });
});

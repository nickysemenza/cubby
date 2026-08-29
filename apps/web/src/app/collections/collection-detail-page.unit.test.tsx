import type { CollectionDetailOut } from "@cubby/schemas/collection";
import { testShortcode } from "@cubby/schemas/testing";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CollectionDetailPage } from "./collection-detail-page";
import { collection } from "./collection.functions";

const PRODUCT_ID = testShortcode("product", "PRD-COLL");
const LOCATION_ID = testShortcode("location", "LOC-COLL");
const PURCHASE_ID = testShortcode("purchase", "PUR-COLL");

const detail: CollectionDetailOut = {
  collection: {
    slug: "painting",
    productCount: 51,
    rootLocationCount: 1,
  },
  roots: [
    {
      id: LOCATION_ID,
      name: "Workshop",
      path: ["Home", "Workshop"],
      imageUrl: null,
    },
  ],
  products: [
    {
      id: PRODUCT_ID,
      name: "Cordless drill",
      manufacturer: "Example Tools",
      imageUrl: null,
      direct: true,
      inherited: true,
      placements: [
        {
          id: LOCATION_ID,
          name: "Workshop",
          path: ["Home", "Workshop"],
        },
      ],
      purchases: [
        {
          id: PURCHASE_ID,
          orderId: "ORDER-1",
          displayLabel: null,
          date: "2026-08-01",
          vendorName: "Example Hardware",
          trades: [],
        },
      ],
    },
  ],
  totalCount: 51,
};

let harness: ReturnType<typeof createBrowserTestHarness>;
let requests: unknown[];

beforeEach(() => {
  requests = [];
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
  vi.unstubAllGlobals();
});

function operations() {
  return {
    detail: collection.detail.withTransport(async ({ input }) => {
      requests.push(input);
      return detail;
    }),
  };
}

describe("CollectionDetailPage product locator", () => {
  it("uses the embedded RTable with fixed server pagination and URL-owned search", async () => {
    const onSearchChange = vi.fn();
    render(
      <CollectionDetailPage
        collection="painting"
        page={1}
        onSearchChange={onSearchChange}
        operations={operations()}
      />,
      { wrapper: harness.wrapper },
    );

    const table = await screen.findByRole("table", {
      name: "Collection products",
    });
    expect(table).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Product" })).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "Current locations" }),
    ).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "Purchase history" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Cordless drill" }),
    ).toHaveAttribute("href", `/products/${PRODUCT_ID}`);
    expect(
      screen.getByRole("button", { name: "Show 1 current location" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show 1 linked purchase" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      within(screen.getByRole("columnheader", { name: "Product" })).queryByRole(
        "button",
        { name: /sort/i },
      ),
    ).toBeNull();

    await waitFor(() =>
      expect(requests).toEqual([
        {
          collection: "painting",
          search: undefined,
          pagination: { pageIndex: 0, pageSize: 50 },
        },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    expect(onSearchChange).toHaveBeenLastCalledWith({ page: 2 });

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search products" }),
      {
        target: { value: "drill" },
      },
    );
    expect(onSearchChange).toHaveBeenLastCalledWith({ q: "drill", page: 1 });
  });

  it("projects manufacturer and relationship popovers into the mobile card", async () => {
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      disconnect() {}
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.stubGlobal("scrollTo", vi.fn());
    window.matchMedia = vi.fn(
      () =>
        ({
          matches: true,
          media: "(max-width: 767px)",
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(() => false),
        }) satisfies MediaQueryList,
    );

    render(
      <CollectionDetailPage
        collection="painting"
        page={1}
        onSearchChange={vi.fn()}
        operations={operations()}
      />,
      { wrapper: harness.wrapper },
    );

    const card = await screen.findByRole("listitem");
    expect(card).toHaveTextContent("Cordless drill");
    expect(card).toHaveTextContent("Example Tools");
    expect(
      screen.getByRole("link", { name: "Cordless drill" }),
    ).toHaveAttribute("href", `/products/${PRODUCT_ID}`);
    expect(
      screen.getByRole("button", { name: "Show 1 current location" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show 1 linked purchase" }),
    ).toBeVisible();
  });
});

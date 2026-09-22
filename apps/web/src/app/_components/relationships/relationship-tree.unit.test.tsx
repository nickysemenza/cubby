import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RelationshipTree } from "./relationship-tree";

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

describe("RelationshipTree display images", () => {
  it("does not relabel first-level records as cycle references in Strict Mode", () => {
    renderTree(
      <StrictMode>
        <RelationshipTree
          presets={[
            {
              key: "connections",
              label: "Connections",
              groups: [
                {
                  key: "vendor.purchases",
                  label: "Purchases",
                  totalCount: 1,
                  items: [
                    {
                      entity: "purchase",
                      id: "PUR-4K7M",
                      label: "Illustrative purchase",
                      displayImage: null,
                    },
                  ],
                },
              ],
            },
          ]}
        />
      </StrictMode>,
    );

    expect(screen.getByText("Illustrative purchase")).toBeInTheDocument();
    expect(screen.queryByText("Reference")).not.toBeInTheDocument();
  });

  it("renders a progressive cover and keeps an icon-only fallback aligned", () => {
    const { container } = renderTree(
      <RelationshipTree
        presets={[
          {
            key: "connections",
            label: "Connections",
            groups: [
              {
                key: "vendor.products",
                label: "Products",
                totalCount: 2,
                items: [
                  {
                    entity: "product",
                    id: "PRD-IMAGE",
                    label: "Photographed product",
                    displayImage: { url: "https://example.com/product.png" },
                  },
                  {
                    entity: "product",
                    id: "PRD-ICON",
                    label: "Icon product",
                    displayImage: null,
                  },
                ],
              },
            ],
          },
        ]}
      />,
    );

    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/product.png",
    );
    expect(screen.getByText("Icon product")).toBeInTheDocument();
  });

  it("keeps paginated rows on the same enriched contract", async () => {
    const loadChildren = vi.fn().mockResolvedValue({
      items: [
        {
          entity: "product",
          id: "PRD-NEXT",
          label: "Next product",
          displayImage: { url: "https://example.com/next.png" },
        },
      ],
      hasMore: false,
    });
    const { container } = renderTree(
      <RelationshipTree
        presets={[
          {
            key: "connections",
            label: "Connections",
            groups: [
              {
                key: "vendor.products",
                label: "Products",
                totalCount: 2,
                items: [
                  {
                    entity: "product",
                    id: "PRD-FIRST",
                    label: "First product",
                    displayImage: null,
                  },
                ],
                hasMore: true,
              },
            ],
          },
        ]}
        loadChildren={loadChildren}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("Next product")).toBeVisible());
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/next.png",
    );
  });

  it("links a ledger party record now that it has a browser detail route", () => {
    // Formerly asserted the opposite (plain text, no link): `ledgerParty` was
    // route-less until it gained `/ledger-parties/$shortcode`. It is a
    // routable entity like any other now, so `isBrowserRoutedEntity` takes
    // the link branch here too.
    renderTree(
      <RelationshipTree
        presets={[
          {
            key: "ledger",
            label: "Ledger",
            groups: [
              {
                key: "account.party",
                label: "Party",
                totalCount: 1,
                items: [
                  {
                    entity: "ledgerParty",
                    id: "LPY-A234",
                    label: "Household",
                    displayImage: null,
                  },
                ],
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Household").closest("a")).toHaveAttribute(
      "href",
      "/ledger-parties/LPY-A234",
    );
  });

  it("surfaces the raw loadChildren failure and retries via onLoadMore", async () => {
    const loadChildren = vi
      .fn()
      .mockRejectedValueOnce(new Error("relation query timed out"))
      .mockResolvedValueOnce({
        items: [
          {
            entity: "product",
            id: "PRD-RETRY",
            label: "Recovered product",
            displayImage: null,
          },
        ],
        hasMore: false,
      });
    renderTree(
      <RelationshipTree
        presets={[
          {
            key: "connections",
            label: "Connections",
            groups: [
              {
                key: "vendor.products",
                label: "Products",
                totalCount: 1,
              },
            ],
          },
        ]}
        initialExpandedGroupKeys={[]}
        loadChildren={loadChildren}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Products/ }));

    expect(await screen.findByText(/relation query timed out/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByText("Recovered product")).toBeVisible(),
    );
    expect(loadChildren).toHaveBeenCalledTimes(2);
  });
});

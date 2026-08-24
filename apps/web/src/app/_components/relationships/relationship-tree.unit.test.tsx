import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => (
    <a href="/entity" className={className}>
      {children}
    </a>
  ),
}));

import { RelationshipTree } from "./relationship-tree";

describe("RelationshipTree display images", () => {
  it("renders a progressive cover and keeps an icon-only fallback aligned", () => {
    const { container } = render(
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
    const { container } = render(
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

  it("renders route-less ledger records as text instead of a broken link", () => {
    render(
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

    expect(screen.getByText("Household").closest("a")).toBeNull();
  });
});

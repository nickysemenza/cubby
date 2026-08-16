import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ProductTagSiblingsOut } from "@cubby/schemas/product";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  data: { current: undefined as ProductTagSiblingsOut | undefined },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data.current, isLoading: false }),
}));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({ product: { tagSiblings: { queryOptions: vi.fn() } } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
// The real link renders a hover-preview card that needs a query client; the
// name and href are all this test asserts on.
vi.mock("../EntityInlineLink", () => ({
  EntityInlineLink: ({
    entity,
    data,
  }: {
    entity: string;
    data: { id: string; name: string };
  }) => (
    <a href={`/${entity}s/${data.id}`} data-entity={entity}>
      {data.name}
    </a>
  ),
}));

import { ProductTagSiblings } from "./product-tag-siblings";

const PRODUCT = {
  id: unsafeProductShortcode("PRD-SRC1"),
  tags: ["m18", "unstocked"],
};

const SIBLING = {
  id: unsafeProductShortcode("PRD-SIB1"),
  name: "Impact Driver",
  manufacturer: "Milwaukee",
  category: null,
  tags: ["m18", "unstocked"],
};

const renderWith = (data: ProductTagSiblingsOut) => {
  mocks.data.current = data;
  return render(<ProductTagSiblings product={PRODUCT} />);
};

/** The block of storage lines rendered under a tag heading. */
const tagBlock = (tag: string) => {
  const badge = screen.getByText(tag);
  const block = badge.closest("div")?.parentElement?.parentElement;
  if (!block) throw new Error(`no block for ${tag}`);
  return within(block);
};

describe("ProductTagSiblings storage lines", () => {
  it("shows each location with its parent path and sibling count", () => {
    renderWith({
      siblings: [SIBLING],
      tagStorage: [
        {
          tag: "m18",
          omittedLocationCount: 0,
          locations: [
            {
              id: unsafeLocationShortcode("LOC-SHLF"),
              name: "Shelf A",
              ancestors: [
                {
                  id: unsafeLocationShortcode("LOC-GRGE"),
                  name: "Garage",
                  type: "room",
                },
              ],
              productCount: 3,
              holdsSource: false,
            },
          ],
        },
      ],
    });

    const block = tagBlock("m18");
    expect(block.getByText("Garage ›")).toBeInTheDocument();
    expect(block.getByRole("link", { name: "Shelf A" })).toHaveAttribute(
      "href",
      "/locations/LOC-SHLF",
    );
    expect(block.getByText("·3")).toBeInTheDocument();
  });

  it("marks a location the viewed product is already stocked in", () => {
    renderWith({
      siblings: [SIBLING],
      tagStorage: [
        {
          tag: "m18",
          omittedLocationCount: 0,
          locations: [
            {
              id: unsafeLocationShortcode("LOC-SHLF"),
              name: "Shelf A",
              ancestors: [],
              productCount: 2,
              holdsSource: true,
            },
            {
              id: unsafeLocationShortcode("LOC-BIN3"),
              name: "Bin 3",
              ancestors: [],
              productCount: 1,
              holdsSource: false,
            },
          ],
        },
      ],
    });

    expect(screen.getAllByLabelText("Stocked here too")).toHaveLength(1);
  });

  it("discloses truncated locations", () => {
    renderWith({
      siblings: [SIBLING],
      tagStorage: [
        {
          tag: "m18",
          omittedLocationCount: 2,
          locations: [
            {
              id: unsafeLocationShortcode("LOC-SHLF"),
              name: "Shelf A",
              ancestors: [],
              productCount: 1,
              holdsSource: false,
            },
          ],
        },
      ],
    });

    expect(screen.getByText("+2 more locations")).toBeInTheDocument();
  });

  it("renders the roster without storage lines for an unstocked tag", () => {
    renderWith({ siblings: [SIBLING], tagStorage: [] });

    // Both tag groups still list the sibling; neither gains a count line.
    expect(screen.getAllByRole("link", { name: "Impact Driver" })).toHaveLength(
      2,
    );
    expect(screen.queryByText(/^·\d/)).not.toBeInTheDocument();
  });
});

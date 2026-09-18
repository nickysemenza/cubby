import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  EntityDisplayImagesProvider,
  entityDisplayImageKey,
} from "./entity-media/entity-display-images";
import { EntityInlineLinkList } from "./EntityInlineLinkList";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("EntityInlineLinkList entity dispatch", () => {
  // Regression: a USDA-linked product row carries an `fdc_id` key. Dispatching
  // on shape ("fdc_id" in item) instead of the declared entity sent every
  // linked product on a USDA food page through the usda-food branch, which
  // reads `foodInfo` and crashed the page.
  it("renders a USDA-linked product as a product, not as a USDA food", () => {
    // Not an object literal at the call site: the `fdc_id` key is the whole
    // point, and an excess-property check would otherwise pick the wrong
    // union member.
    const linkedProduct = {
      id: "PRD-TEST",
      name: "Fairlife 2% milk",
      manufacturer: "Fairlife",
      fdc_id: 2670155,
    };
    render(<EntityInlineLinkList entity="product" items={[linkedProduct]} />, {
      wrapper: harness.wrapper,
    });

    expect(
      screen.getByRole("link", { name: /Fairlife 2% milk/ }),
    ).toHaveAttribute("href", "/products/PRD-TEST");
  });

  it("still renders declared USDA foods through the usda-food branch", () => {
    render(
      <EntityInlineLinkList
        entity="usda-food"
        items={[{ fdc_id: 171265, foodInfo: { description: "Milk, whole" } }]}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("link", { name: "Milk, whole" })).toHaveAttribute(
      "href",
      "/usda/171265",
    );
  });

  it("uses a collection owner's canonical image without issuing a cell request", () => {
    const product = {
      id: "PRD-TABLE",
      name: "Table-owned image",
      manufacturer: "Cubby",
    };
    render(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={{
          [entityDisplayImageKey({
            entityType: "product",
            entityId: product.id,
          })]: { url: "https://images.example/table-owned.jpg" },
        }}
      >
        <EntityInlineLinkList
          entity="product"
          items={[product]}
          resolveImages={false}
        />
      </EntityDisplayImagesProvider>,
      { wrapper: harness.wrapper },
    );

    expect(
      screen
        .getByRole("link", { name: /Table-owned image/ })
        .querySelector("img"),
    ).toHaveAttribute("src", "https://images.example/table-owned.jpg");
  });
});

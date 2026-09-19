import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityInlineLink } from "./EntityInlineLink";

const enrichedProduct = {
  id: "PRD-TEST",
  name: "Test product",
  images: [{ url: "https://example.com/product.jpg" }],
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function productLink() {
  return screen.getByRole("link", { name: "Test product" });
}

describe("EntityInlineLink display images", () => {
  it("renders the explicitly supplied canonical image", () => {
    render(
      <EntityInlineLink
        entity="product"
        data={enrichedProduct}
        displayImage={enrichedProduct.images[0] ?? null}
      />,
      { wrapper: harness.wrapper },
    );

    expect(productLink().querySelector("img")).toHaveAttribute(
      "src",
      enrichedProduct.images[0]?.url,
    );
  });

  it("suppresses its identity mark when adjacent media already supplies it", () => {
    render(
      <EntityInlineLink
        entity="product"
        data={enrichedProduct}
        displayImage={enrichedProduct.images[0] ?? null}
        showIdentityMark={false}
      />,
      { wrapper: harness.wrapper },
    );

    const link = productLink();
    expect(link.querySelector("img")).toBeNull();
    expect(link.querySelector("svg")).toBeNull();
  });
});

describe("EntityInlineLink complete preview roster", () => {
  it.each([
    [
      "financialAccount",
      "/financial-accounts/FAC-TEST",
      () => (
        <EntityInlineLink
          entity="financialAccount"
          data={{ id: "FAC-TEST", name: "Checking" }}
          displayImage={null}
        />
      ),
    ],
    [
      "financialTransaction",
      "/financial-transactions/FTX-TEST",
      () => (
        <EntityInlineLink
          entity="financialTransaction"
          data={{ id: "FTX-TEST", displayName: "Market purchase" }}
          displayImage={null}
        />
      ),
    ],
    [
      "wish",
      "/wishes/WSH-TEST",
      () => (
        <EntityInlineLink
          entity="wish"
          data={{ id: "WSH-TEST", name: "Garden bench" }}
          displayImage={null}
        />
      ),
    ],
    [
      "image",
      "/images/IMG-TEST",
      () => (
        <EntityInlineLink
          entity="image"
          data={{ id: "IMG-TEST", filename: "bench.jpg" }}
          displayImage={null}
        />
      ),
    ],
  ] as const)(
    "links %s with its declared title field",
    (_entity, href, renderLink) => {
      render(renderLink(), { wrapper: harness.wrapper });

      expect(screen.getByRole("link")).toHaveAttribute("href", href);
    },
  );
});

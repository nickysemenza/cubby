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
  it("links all four entities using their real title fields", () => {
    render(
      <>
        <EntityInlineLink
          entity="financialAccount"
          data={{ id: "FAC-TEST", name: "Checking" }}
          displayImage={null}
        />
        <EntityInlineLink
          entity="financialTransaction"
          data={{ id: "FTX-TEST", displayName: "Market purchase" }}
          displayImage={null}
        />
        <EntityInlineLink
          entity="wish"
          data={{ id: "WSH-TEST", name: "Garden bench" }}
          displayImage={null}
        />
        <EntityInlineLink
          entity="image"
          data={{ id: "IMG-TEST", filename: "bench.jpg" }}
          displayImage={null}
        />
      </>,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("link", { name: "Checking" })).toHaveAttribute(
      "href",
      "/financial-accounts/FAC-TEST",
    );
    expect(
      screen.getByRole("link", { name: "Market purchase" }),
    ).toHaveAttribute("href", "/financial-transactions/FTX-TEST");
    expect(screen.getByRole("link", { name: "Garden bench" })).toHaveAttribute(
      "href",
      "/wishes/WSH-TEST",
    );
    expect(screen.getByRole("link", { name: "bench.jpg" })).toHaveAttribute(
      "href",
      "/images/IMG-TEST",
    );
  });
});

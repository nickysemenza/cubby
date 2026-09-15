import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
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

function inlineImage(link: HTMLElement): HTMLImageElement {
  const image = link.querySelector("img");
  if (!image) throw new Error("Expected an inline identity image.");
  return image;
}

describe("EntityInlineLink display images", () => {
  it("derives the image from an established enriched read projection", () => {
    render(
      <EntityInlineLink
        entity="product"
        data={enrichedProduct}
        displayImage={undefined}
      />,
      { wrapper: harness.wrapper },
    );

    expect(inlineImage(productLink())).toHaveAttribute(
      "src",
      enrichedProduct.images[0]?.url,
    );
    expect(productLink()).toHaveAttribute("href", "/products/PRD-TEST");
  });

  it("prefers a location's own photo over the cover of the SKU it is", () => {
    render(
      <EntityInlineLink
        entity="location"
        data={{
          id: "LOC-BIN",
          name: "Blue tote",
          images: [{ url: "https://example.com/tote-in-place.jpg" }],
          product: {
            category: null,
            coverImage: { url: "https://example.com/sku.jpg" },
          },
        }}
        displayImage={undefined}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      inlineImage(screen.getByRole("link", { name: "Blue tote" })),
    ).toHaveAttribute("src", "https://example.com/tote-in-place.jpg");
  });

  it("falls back to the cover of the SKU a location is when it has no photo", () => {
    render(
      <EntityInlineLink
        entity="location"
        data={{
          id: "LOC-BIN",
          name: "Metal rack",
          images: [],
          product: {
            category: null,
            coverImage: { url: "https://example.com/rack.jpg" },
          },
        }}
        displayImage={undefined}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      inlineImage(screen.getByRole("link", { name: "Metal rack" })),
    ).toHaveAttribute("src", "https://example.com/rack.jpg");
  });

  it("never draws an attached PDF manual as a thumbnail", () => {
    render(
      <EntityInlineLink
        entity="location"
        data={{
          id: "LOC-BIN",
          name: "Workbench",
          // Documents share the images relation on purpose, so the sniffer has
          // to skip them rather than trust position.
          images: [
            {
              url: "https://example.com/manual.pdf",
              contentType: PDF_CONTENT_TYPE,
            },
            {
              url: "https://example.com/bench.jpg",
              contentType: "image/jpeg",
            },
          ],
        }}
        displayImage={undefined}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      inlineImage(screen.getByRole("link", { name: "Workbench" })),
    ).toHaveAttribute("src", "https://example.com/bench.jpg");
  });

  it("suppresses its identity mark when adjacent media already supplies it", () => {
    render(
      <EntityInlineLink
        entity="product"
        data={enrichedProduct}
        displayImage={enrichedProduct.images[0]}
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

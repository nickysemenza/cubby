import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { EntityInlineLink } from "./EntityInlineLink";

vi.mock("./EntityPreviewLink", () => ({
  EntityPreviewLink: ({
    children,
    displayImage,
    showIdentityMark,
  }: {
    children: ReactNode;
    displayImage: { url: string } | null;
    showIdentityMark?: boolean;
  }) => (
    <span
      data-testid="entity-link"
      data-image={displayImage?.url ?? "none"}
      data-show-mark={showIdentityMark === false ? "false" : "true"}
    >
      {children}
    </span>
  ),
}));

const enrichedProduct = {
  id: "PRD-TEST",
  name: "Test product",
  images: [{ url: "https://example.com/product.jpg" }],
};

describe("EntityInlineLink display images", () => {
  it("derives the image from an established enriched read projection", () => {
    render(
      <EntityInlineLink
        entity="product"
        data={enrichedProduct}
        displayImage={undefined}
      />,
    );

    expect(screen.getByTestId("entity-link")).toHaveAttribute(
      "data-image",
      enrichedProduct.images[0]?.url,
    );
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
    );

    expect(screen.getByTestId("entity-link")).toHaveAttribute(
      "data-image",
      "https://example.com/tote-in-place.jpg",
    );
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
    );

    expect(screen.getByTestId("entity-link")).toHaveAttribute(
      "data-image",
      "https://example.com/rack.jpg",
    );
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
    );

    expect(screen.getByTestId("entity-link")).toHaveAttribute(
      "data-image",
      "https://example.com/bench.jpg",
    );
  });

  it("suppresses its identity mark when adjacent media already supplies it", () => {
    render(
      <EntityInlineLink
        entity="product"
        data={enrichedProduct}
        displayImage={enrichedProduct.images[0]}
        showIdentityMark={false}
      />,
    );

    expect(screen.getByTestId("entity-link")).toHaveAttribute(
      "data-show-mark",
      "false",
    );
  });
});

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

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityIdentityMark } from "./entity-identity-mark";

describe("EntityIdentityMark", () => {
  it("keeps the entity icon in a fixed inline slot without an image", () => {
    const { container } = render(
      <EntityIdentityMark entity="recipe" displayImage={null} />,
    );
    const mark = container.firstElementChild;
    expect(mark).toHaveStyle({ width: "16px", height: "16px" });
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveStyle({
      color: "var(--domain-cook)",
    });
  });

  it("uses contain for catalog-like identity assets", () => {
    const { container } = render(
      <EntityIdentityMark
        entity="product"
        displayImage={{ url: "https://example.com/product.png" }}
      />,
    );
    expect(container.querySelector("img")).toHaveClass("object-contain");
  });

  it("shows the semantic fallback until decode and after an image failure", () => {
    const { container } = render(
      <EntityIdentityMark
        entity="recipe"
        displayImage={{ url: "https://example.com/recipe.png" }}
        fallback={<span>recipe mark</span>}
      />,
    );
    expect(screen.getByText("recipe mark")).toBeInTheDocument();
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    if (!image) return;
    fireEvent.load(image);
    expect(screen.queryByText("recipe mark")).toBeNull();
    fireEvent.error(image);
    expect(screen.getByText("recipe mark")).toBeInTheDocument();
  });
});

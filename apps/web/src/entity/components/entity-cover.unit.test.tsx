import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EntityCover } from "./entity-cover";

describe("EntityCover", () => {
  it("uses product-safe contain sizing and counts extra images when it has room", () => {
    const cover = (size: number) => (
      <EntityCover
        images={[
          { url: "https://example.com/one.png" },
          { url: "https://example.com/two.png" },
        ]}
        entity="product"
        alt="Paint tin"
        size={size}
      />
    );
    const { rerender } = render(cover(64));

    expect(screen.getByRole("img", { name: "Paint tin" })).toHaveClass(
      "object-contain",
    );
    expect(screen.getByText("+1")).toBeInTheDocument();
    rerender(cover(24));
    expect(screen.queryByText("+1")).not.toBeInTheDocument();
  });

  it("renders no reserved tile when an optional cover is absent", () => {
    const { container } = render(
      <EntityCover images={[]} entity="recipe" placeholder="none" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("replaces a failed transformed and original image with its fallback", () => {
    render(
      <EntityCover
        images={[{ url: "https://example.com/broken.png" }]}
        alt="Broken cover"
        fallback={<span>Cover unavailable</span>}
        size={40}
      />,
    );

    const image = screen.getByRole("img", { name: "Broken cover" });
    fireEvent.error(image);
    fireEvent.error(image);
    expect(screen.getByText("Cover unavailable")).toBeInTheDocument();
  });
});

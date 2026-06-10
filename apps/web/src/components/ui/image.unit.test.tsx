import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Image } from "./image";

describe("Image", () => {
  it("renders an <img> for a valid src", () => {
    render(<Image src="https://example.com/a.jpg" alt="a product" />);
    expect(screen.getByRole("img", { name: "a product" }).tagName).toBe("IMG");
  });

  it("renders the fallback instead of a broken <img> when src is missing", () => {
    render(<Image src="" alt="no photo" fallback={<span>tile</span>} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("tile")).toBeInTheDocument();
  });

  it("falls back to a muted icon tile (not a broken glyph) with no custom fallback", () => {
    // Regression: a failed image used to reveal the browser's broken-image
    // glyph with the literal alt text ("Image"). It must degrade gracefully.
    const { container } = render(<Image src="" alt="missing" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector('[aria-label="missing"]')).not.toBeNull();
  });

  it("swaps to the fallback when the image fails to load", () => {
    render(
      <Image
        src="https://example.com/broken.jpg"
        alt="broken"
        fallback={<span>tile</span>}
      />,
    );
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("tile")).toBeInTheDocument();
  });
});

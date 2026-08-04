import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImageWithPreview } from "./image-with-preview";

const BUCKET_SRC = "https://foobucket.nicky.fun/cubby/images/a.jpg";

describe("ImageWithPreview", () => {
  it("transforms the thumbnail at `size` when displayWidth is omitted", () => {
    // Regression: `size` (layout box) and `displayWidth` (CF transform width)
    // were independent optional props, so a caller that set only `size` served
    // the full-size original into a tiny tile. The locations gallery did
    // exactly that with 1.8MB location photos in 32px boxes.
    render(<ImageWithPreview src={BUCKET_SRC} alt="p" size={32} />);
    const img = screen.getByRole("img", { name: "p" });
    expect(img.getAttribute("src")).toBe(
      "https://foobucket.nicky.fun/cdn-cgi/image/width=32,quality=80,format=auto,fit=scale-down/cubby/images/a.jpg",
    );
    expect(img.getAttribute("srcset")).toBe(
      "https://foobucket.nicky.fun/cdn-cgi/image/width=32,quality=80,format=auto,fit=scale-down/cubby/images/a.jpg 1x, https://foobucket.nicky.fun/cdn-cgi/image/width=64,quality=80,format=auto,fit=scale-down/cubby/images/a.jpg 2x",
    );
  });

  it("lets an explicit displayWidth override `size`", () => {
    render(
      <ImageWithPreview
        src={BUCKET_SRC}
        alt="p"
        size={32}
        displayWidth={128}
      />,
    );
    expect(screen.getByRole("img", { name: "p" }).getAttribute("src")).toContain(
      "width=128",
    );
  });

  it("serves the original when neither size nor displayWidth is given", () => {
    // className-sized callers opt out deliberately; nothing to derive a width
    // from, so the transform stays off rather than guessing.
    render(<ImageWithPreview src={BUCKET_SRC} alt="p" />);
    const img = screen.getByRole("img", { name: "p" });
    expect(img.getAttribute("src")).toBe(BUCKET_SRC);
    expect(img.getAttribute("srcset")).toBeNull();
  });
});

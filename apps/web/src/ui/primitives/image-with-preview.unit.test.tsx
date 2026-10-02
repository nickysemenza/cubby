import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImageWithPreview } from "./image-with-preview";

const BUCKET_SRC = `${__R2_PUBLIC_URL__}/cubby/images/a.jpg`;
const transformed = (width: number) =>
  `${__R2_PUBLIC_URL__}/cdn-cgi/image/width=${width},quality=80,format=auto,fit=scale-down/cubby/images/a.jpg`;

describe("ImageWithPreview", () => {
  it("transforms the thumbnail at `size` when displayWidth is omitted", () => {
    // Regression: `size` (layout box) and `displayWidth` (CF transform width)
    // were independent optional props, so a caller that set only `size` served
    // the full-size original into a tiny tile. The locations gallery did
    // exactly that with 1.8MB location photos in 32px boxes.
    render(<ImageWithPreview src={BUCKET_SRC} alt="p" size={32} />);
    const img = screen.getByRole("img", { name: "p" });
    // 32px rendered → 2× → the 128 rung; no srcSet, one URL per placement.
    expect(img.getAttribute("src")).toBe(transformed(128));
    expect(img.getAttribute("srcset")).toBeNull();
  });

  it("lets an explicit displayWidth override `size`", () => {
    render(
      <ImageWithPreview
        src={BUCKET_SRC}
        alt="p"
        size={32}
        displayWidth={200}
      />,
    );
    // 200px rendered → 400 → the 640 rung, not the 128 rung `size` would pick.
    expect(screen.getByRole("img", { name: "p" }).getAttribute("src")).toBe(
      transformed(640),
    );
  });

  it("uses the documented 40px default when no width is given", () => {
    render(<ImageWithPreview src={BUCKET_SRC} alt="p" />);
    const img = screen.getByRole("img", { name: "p" });
    expect(img.getAttribute("src")).toBe(transformed(128));
    expect(img.getAttribute("srcset")).toBeNull();
  });
});

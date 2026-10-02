import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Image } from "./image";

describe("Image", () => {
  it("renders the fallback instead of a broken <img> when src is missing", () => {
    render(
      <Image src="" alt="no photo" fallback={<span>tile</span>} unoptimized />,
    );
    expect(screen.getByRole("img", { name: "no photo" }).tagName).toBe("DIV");
    expect(screen.getByText("tile")).toBeInTheDocument();
  });

  it("falls back to a muted icon tile (not a broken glyph) with no custom fallback", () => {
    // Regression: a failed image used to reveal the browser's broken-image
    // glyph with the literal alt text ("Image"). It must degrade gracefully.
    render(<Image src="" alt="missing" unoptimized />);
    expect(screen.getByRole("img", { name: "missing" }).tagName).toBe("DIV");
  });

  it("keeps an empty-alt fallback decorative", () => {
    const { container } = render(<Image src="" alt="" unoptimized />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("swaps to the fallback when the image fails to load", () => {
    render(
      <Image
        src="https://example.com/broken.jpg"
        alt="broken"
        fallback={<span>tile</span>}
        unoptimized
      />,
    );
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("img", { name: "broken" }).tagName).toBe("DIV");
    expect(screen.getByText("tile")).toBeInTheDocument();
  });

  it("keeps a supplied semantic fallback visible until the image loads", () => {
    render(
      <Image
        src="https://example.com/loading.jpg"
        alt="loading"
        loadingFallback={<span>entity icon</span>}
        unoptimized
      />,
    );
    expect(screen.getByText("entity icon")).toBeInTheDocument();
    fireEvent.load(screen.getByRole("img", { name: "loading" }));
    expect(screen.queryByText("entity icon")).toBeNull();
  });

  const BUCKET_SRC = `${__R2_PUBLIC_URL__}/cubby/images/a.jpg`;

  it("requests the snapped CF transform (no srcSet) when displayWidth is set on a bucket URL", () => {
    render(<Image src={BUCKET_SRC} alt="p" displayWidth={40} />);
    const img = screen.getByRole("img", { name: "p" });
    // 40px rendered → 2× = 80 → snaps up to the 128 rung.
    expect(img.getAttribute("src")).toBe(
      `${__R2_PUBLIC_URL__}/cdn-cgi/image/width=128,quality=80,format=auto,fit=scale-down/cubby/images/a.jpg`,
    );
    expect(img.getAttribute("srcset")).toBeNull();
  });

  it("uses the original src (no srcSet) when displayWidth is omitted", () => {
    render(<Image src={BUCKET_SRC} alt="p" unoptimized />);
    const img = screen.getByRole("img", { name: "p" });
    expect(img.getAttribute("src")).toBe(BUCKET_SRC);
    expect(img.getAttribute("srcset")).toBeNull();
  });

  it("leaves non-bucket URLs untransformed even with displayWidth", () => {
    render(<Image src="https://example.com/a.jpg" alt="p" displayWidth={400} />);
    expect(screen.getByRole("img", { name: "p" }).getAttribute("src")).toBe(
      "https://example.com/a.jpg",
    );
  });

  it("falls back to the original URL once before erroring when a transform fails", () => {
    render(
      <Image
        src={BUCKET_SRC}
        alt="p"
        displayWidth={400}
        fallback={<span>tile</span>}
      />,
    );
    const img = screen.getByRole("img", { name: "p" });
    expect(img.getAttribute("src")).toContain("/cdn-cgi/image/");
    // First error: retry with the original URL, still an <img> (no fallback yet).
    fireEvent.error(img);
    const retried = screen.getByRole("img", { name: "p" });
    expect(retried.getAttribute("src")).toBe(BUCKET_SRC);
    expect(retried.getAttribute("srcset")).toBeNull();
    // Original also fails → fallback tile.
    fireEvent.error(retried);
    expect(screen.getByRole("img", { name: "p" }).tagName).toBe("DIV");
    expect(screen.getByText("tile")).toBeInTheDocument();
  });
});

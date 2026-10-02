import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { PhotoViewer } from "./photo-viewer";

const images = [
  { id: "IMG-FIRST", url: "https://example.com/first.jpg", filename: "First" },
  {
    id: "IMG-SECOND",
    url: "https://example.com/second.jpg",
    filename: "Second",
  },
];

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("PhotoViewer", () => {
  it("moves through the selected batch and links to the current image details", () => {
    const onIndexChange = vi.fn();
    render(
      <PhotoViewer
        images={images}
        index={0}
        onIndexChange={onIndexChange}
        onOpenChange={vi.fn()}
        detailLink={(image) => ({ shortcode: image.id })}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByText("Image 1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous image" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "View image details" }),
    ).toHaveAttribute("href", "/images/IMG-FIRST");

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it("can preview the next image after a different image fails to load", () => {
    const props = { images, onIndexChange: vi.fn(), onOpenChange: vi.fn() };
    const view = render(<PhotoViewer {...props} index={0} />, {
      wrapper: harness.wrapper,
    });
    fireEvent.error(screen.getByAltText("First"));
    view.rerender(<PhotoViewer {...props} index={1} />);
    expect(screen.getByAltText("Second")).toHaveAttribute(
      "src",
      images[1]!.url,
    );
    expect(
      screen.queryByRole("link", { name: "View image details" }),
    ).toBeNull();
  });
});

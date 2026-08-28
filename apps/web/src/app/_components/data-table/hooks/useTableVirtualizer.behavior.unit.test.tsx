import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTableVirtualizer } from "./useTableVirtualizer";

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];

  readonly observedElements = new Set<Element>();
  readonly observe = vi.fn((element: Element) => {
    this.observedElements.add(element);
  });
  readonly unobserve = vi.fn((element: Element) => {
    this.observedElements.delete(element);
  });
  readonly disconnect = vi.fn(() => {
    this.observedElements.clear();
  });

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  trigger() {
    this.callback([], this);
  }
}

const ROW_KEYS = Array.from({ length: 100 }, (_, index) => `row-${index}`);

function isScrollToOptions(
  value: number | ScrollToOptions | undefined,
): value is ScrollToOptions {
  return typeof value === "object" && value !== null;
}

function Harness() {
  const virtualizer = useTableVirtualizer({
    rowCount: ROW_KEYS.length,
    rowKeys: ROW_KEYS,
    groupedItems: null,
    rowHeight: 28,
    isMobile: false,
  });

  return (
    <div ref={virtualizer.paneWrapperRef} data-pane-wrapper="true">
      <div
        ref={virtualizer.tableContainerRef}
        data-testid="pane"
        data-max-height={virtualizer.paneMaxHeight ?? ""}
        data-virtual-count={virtualizer.virtualRows.length}
      >
        <button type="button" onClick={() => virtualizer.scrollToIndex(50)}>
          Jump to row
        </button>
      </div>
    </div>
  );
}

describe("useTableVirtualizer pane scrolling", () => {
  let wrapperTop = 220;
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    wrapperTop = 220;
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    window.innerHeight = 900;

    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top = this.dataset.paneWrapper === "true" ? wrapperTop : 0;
        return {
          x: 0,
          y: top,
          top,
          right: 0,
          bottom: top,
          left: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        };
      });
  });

  afterEach(() => {
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("scrolls the pane rather than the window", () => {
    render(<Harness />);

    const pane = screen.getByTestId("pane");
    const scrollRequests: ScrollToOptions[] = [];
    pane.scrollTo = (options) => {
      if (isScrollToOptions(options)) scrollRequests.push(options);
    };

    fireEvent.click(screen.getByRole("button", { name: "Jump to row" }));

    expect(scrollRequests.at(-1)).toEqual(
      expect.objectContaining({ top: expect.any(Number) }),
    );
    expect(pane).toHaveAttribute("data-virtual-count");
  });

  it("bounds the pane to the viewport left beneath the wrapper", () => {
    render(<Harness />);

    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "672",
    );
  });

  it("remeasures when the wrapper moves", () => {
    const { unmount } = render(<Harness />);

    const wrapper = screen.getByTestId("pane").parentElement;
    if (!wrapper) throw new Error("Pane wrapper was not created");
    const wrapperObserver = TestResizeObserver.instances.find((observer) =>
      observer.observedElements.has(wrapper),
    );
    expect(wrapperObserver?.observe).toHaveBeenCalled();

    wrapperTop = 400;
    act(() => {
      wrapperObserver?.trigger();
    });

    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "492",
    );

    unmount();
    expect(wrapperObserver?.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a usable height on a short viewport", () => {
    window.innerHeight = 300;
    wrapperTop = 260;
    render(<Harness />);

    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "320",
    );
  });
});

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTableVirtualizer } from "./useTableVirtualizer";

const mocks = vi.hoisted(() => ({
  latestOptions: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useWindowVirtualizer: (options: Record<string, unknown>) => {
    mocks.latestOptions = options;
    return {
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      scrollToIndex: mocks.scrollToIndex,
    };
  },
}));

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];

  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
}

const ROW_KEYS = Array.from({ length: 100 }, (_, index) => `row-${index}`);

function Harness() {
  const virtualizer = useTableVirtualizer({
    rowCount: ROW_KEYS.length,
    rowKeys: ROW_KEYS,
    groupedItems: null,
    rowHeight: 28,
    isMobile: false,
  });

  return (
    <div
      ref={virtualizer.tableContainerRef}
      data-table-anchor="true"
      data-testid="table-anchor"
      data-scroll-margin={virtualizer.scrollMargin}
    />
  );
}

describe("useTableVirtualizer document offset tracking", () => {
  let tableDocumentTop = 600;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let animationFrames: FrameRequestCallback[];

  const flushAnimationFrames = () => {
    const pending = animationFrames.splice(0);
    for (const callback of pending) callback(0);
  };

  beforeEach(() => {
    tableDocumentTop = 600;
    animationFrames = [];
    TestResizeObserver.instances = [];
    mocks.latestOptions = null;
    mocks.scrollToIndex.mockClear();

    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top =
          this.dataset.tableAnchor === "true"
            ? tableDocumentTop - window.scrollY
            : 0;
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

  it("remeasures after preceding content changes the document layout", () => {
    const { unmount } = render(<Harness />);

    expect(screen.getByTestId("table-anchor")).toHaveAttribute(
      "data-scroll-margin",
      "600",
    );
    expect(mocks.latestOptions?.scrollMargin).toBe(600);

    const bodyObserver = TestResizeObserver.instances[0];
    expect(bodyObserver?.observe).toHaveBeenCalledWith(document.body);

    tableDocumentTop = 2600;
    act(() => {
      bodyObserver?.callback([], bodyObserver as unknown as ResizeObserver);
      flushAnimationFrames();
    });

    expect(screen.getByTestId("table-anchor")).toHaveAttribute(
      "data-scroll-margin",
      "2600",
    );
    expect(mocks.latestOptions?.scrollMargin).toBe(2600);

    unmount();
    expect(bodyObserver?.disconnect).toHaveBeenCalledOnce();
  });

  it("remeasures on scroll when total document height does not change", () => {
    render(<Harness />);
    tableDocumentTop = 3100;

    act(() => {
      window.dispatchEvent(new Event("scroll"));
      flushAnimationFrames();
    });

    expect(screen.getByTestId("table-anchor")).toHaveAttribute(
      "data-scroll-margin",
      "3100",
    );
    expect(mocks.latestOptions?.scrollMargin).toBe(3100);
  });
});

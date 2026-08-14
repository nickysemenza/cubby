import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTableVirtualizer } from "./useTableVirtualizer";

const mocks = vi.hoisted(() => ({
  latestOptions: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: Record<string, unknown>) => {
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
    <div ref={virtualizer.paneWrapperRef} data-pane-wrapper="true">
      <div
        ref={virtualizer.tableContainerRef}
        data-testid="pane"
        data-max-height={virtualizer.paneMaxHeight ?? ""}
      />
    </div>
  );
}

describe("useTableVirtualizer pane scrolling", () => {
  let wrapperTop = 220;
  let belowChrome = 0;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let scrollHeightSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    wrapperTop = 220;
    belowChrome = 0;
    TestResizeObserver.instances = [];
    mocks.latestOptions = null;
    mocks.scrollToIndex.mockClear();

    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    window.innerHeight = 900;

    // The wrapper's bottom plus whatever the shell renders under it. The hook
    // derives the bottom chrome from these two, so the test drives both.
    // The hook measures the shell's footer element directly.
    const footer = document.createElement("div");
    footer.setAttribute("data-app-footer", "");
    footer.getBoundingClientRect = () => ({ height: belowChrome }) as DOMRect;
    document.body.appendChild(footer);
    scrollHeightSpy = { mockRestore: () => footer.remove() } as ReturnType<
      typeof vi.spyOn
    >;

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
    scrollHeightSpy.mockRestore();
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("scrolls the pane rather than the window", () => {
    render(<Harness />);

    // The scroll element is the table's own pane. If this regresses to window
    // virtualization, a wide table drags the whole page sideways and the nav
    // rail, page header and column header all leave the viewport.
    const options = mocks.latestOptions;
    expect(options).not.toBeNull();
    const getScrollElement = options?.getScrollElement as
      | (() => HTMLElement | null)
      | undefined;
    expect(typeof getScrollElement).toBe("function");
    expect(getScrollElement?.()).toBe(screen.getByTestId("pane"));

    // scrollMargin is a window-virtualization concept: the table's distance
    // from the top of the document. A pane's own scrollTop is already the
    // right origin, so passing one would double-count the offset.
    expect(mocks.latestOptions).not.toHaveProperty("scrollMargin");
  });

  it("bounds the pane to the viewport left beneath the wrapper", () => {
    render(<Harness />);

    // 900 viewport - 220 wrapper top - 0 chrome below it.
    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "680",
    );
  });

  it("remeasures when the wrapper moves", () => {
    const { unmount } = render(<Harness />);

    const wrapperObserver = TestResizeObserver.instances[0];
    expect(wrapperObserver?.observe).toHaveBeenCalled();

    wrapperTop = 400;
    act(() => {
      wrapperObserver?.callback(
        [],
        wrapperObserver as unknown as ResizeObserver,
      );
    });

    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "500",
    );

    unmount();
    expect(wrapperObserver?.disconnect).toHaveBeenCalledOnce();
  });

  it("subtracts the chrome the shell renders below the pane", () => {
    // A hardcoded gutter left every list page 23px taller than the viewport,
    // so one flick slid the whole toolbar behind the sticky command header.
    belowChrome = 51;
    render(<Harness />);

    // 900 - 220 - 51: the page is exactly as tall as the viewport, not taller.
    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "629",
    );
  });

  it("keeps a usable height on a short viewport", () => {
    window.innerHeight = 300;
    wrapperTop = 260;
    render(<Harness />);

    // Floor, not `300 - 260 - 8 = 32`: a couple of visible rows is worse than
    // a pane that overflows a cramped viewport.
    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "320",
    );
  });
});

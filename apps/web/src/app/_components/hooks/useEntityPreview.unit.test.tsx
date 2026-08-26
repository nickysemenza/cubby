import type * as TanStackQuery from "@tanstack/react-query";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryClient = vi.hoisted(() => ({
  cancelQueries: vi.fn(async () => undefined),
  prefetchQuery: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackQuery>()),
  useQueryClient: () => queryClient,
}));

vi.mock("~/entities/entity-query", () => ({
  entityPreviewQueryOptions: (entity: string, id: string) => ({
    queryKey: [[entity, "detail"], { shortcode: id }],
    queryFn: async () => ({ id }),
  }),
}));

vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ children }: PropsWithChildren<{ open: boolean }>) => (
    <div data-testid="preview-sheet">{children}</div>
  ),
  SheetContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

vi.mock("../entity-workbench-inspector", () => ({
  EntityWorkbenchInspector: ({
    entity,
    id,
  }: {
    entity: string;
    id: string;
  }) => (
    <div data-testid="workbench-inspector">
      {entity}:{id}
    </div>
  ),
}));

import { useEntityPreview } from "./useEntityPreview";

const row = (id: string) => ({ original: { id } });

type PreviewViewport = "dock" | "sheet" | "mobile";

let viewport: PreviewViewport = "mobile";
const mediaListeners = new Set<() => void>();

function setViewport(nextViewport: PreviewViewport) {
  viewport = nextViewport;
  for (const listener of mediaListeners) listener();
}

function matchesMediaQuery(query: string) {
  if (query.includes("min-width: 1280px")) return viewport === "dock";
  if (query.includes("min-width: 768px")) return viewport === "sheet";
  return false;
}

describe("useEntityPreview intent prefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    viewport = "mobile";
    mediaListeners.clear();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: matchesMediaQuery(query),
        media: query,
        onchange: null,
        addEventListener: (_event: string, listener: () => void) =>
          mediaListeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) =>
          mediaListeners.delete(listener),
        addListener: (listener: () => void) => mediaListeners.add(listener),
        removeListener: (listener: () => void) =>
          mediaListeners.delete(listener),
        dispatchEvent: () => false,
      })),
    );
    queryClient.cancelQueries.mockClear();
    queryClient.prefetchQuery.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not fan out detail requests while the pointer sweeps rows", () => {
    const { result } = renderHook(() => useEntityPreview("product"));

    act(() => {
      for (let index = 0; index < 10; index += 1) {
        result.current.onRowHover(row(`PRD-${index}`));
      }
    });

    expect(queryClient.prefetchQuery).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(199));
    expect(queryClient.prefetchQuery).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(queryClient.prefetchQuery).toHaveBeenCalledTimes(1);
    expect(queryClient.prefetchQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryKey: [["product", "detail"], { shortcode: "PRD-9" }],
      }),
    );
  });

  it("cancels a dispatched prefetch after intent ends", () => {
    const { result } = renderHook(() => useEntityPreview("product"));
    const hovered = row("PRD-4K7M");

    act(() => result.current.onRowHover(hovered));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.onRowHoverEnd(hovered));

    expect(queryClient.cancelQueries).toHaveBeenCalledWith({
      queryKey: [["product", "detail"], { shortcode: "PRD-4K7M" }],
      exact: true,
      type: "inactive",
    });
  });

  it("commits a pending intent on click without starting a second prefetch", () => {
    const { result } = renderHook(() => useEntityPreview("product"));
    const hovered = row("PRD-4K7M");

    act(() => result.current.onRowHover(hovered));
    act(() => result.current.onRowClick(hovered));
    act(() => vi.advanceTimersByTime(200));

    expect(result.current.preview).toEqual({
      entityType: "product",
      id: "PRD-4K7M",
    });
    expect(queryClient.prefetchQuery).not.toHaveBeenCalled();
    expect(queryClient.cancelQueries).not.toHaveBeenCalled();
  });

  it("docks the selected inspector at desktop widths", () => {
    viewport = "dock";
    const { result } = renderHook(() =>
      useEntityPreview("product", { responsiveInspector: true }),
    );

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(result.current.dockedInspector);

    expect(screen.getByTestId("workbench-inspector")).toHaveTextContent(
      "product:PRD-4K7M",
    );
  });

  it("uses the same inspector in a compact Sheet at medium widths", () => {
    viewport = "sheet";
    const { result } = renderHook(() =>
      useEntityPreview("product", { responsiveInspector: true }),
    );

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByTestId("preview-sheet")).toContainElement(
      screen.getByTestId("workbench-inspector"),
    );
  });

  it("keeps selection state but renders no inspector on mobile", () => {
    const { result } = renderHook(() =>
      useEntityPreview("product", { responsiveInspector: true }),
    );

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.preview).toEqual({
      entityType: "product",
      id: "PRD-4K7M",
    });
    expect(result.current.dockedInspector).toBeNull();
    expect(screen.queryByTestId("workbench-inspector")).not.toBeInTheDocument();
  });

  it("moves an open preview between dock and Sheet when the viewport changes", () => {
    viewport = "dock";
    const { result } = renderHook(() =>
      useEntityPreview("product", { responsiveInspector: true }),
    );
    act(() => result.current.onRowClick(row("PRD-4K7M")));

    expect(result.current.dockedInspector).not.toBeNull();
    act(() => setViewport("sheet"));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByTestId("workbench-inspector")).toHaveTextContent(
      "product:PRD-4K7M",
    );
  });

  it("keeps the legacy Sheet visible at desktop widths", () => {
    viewport = "dock";
    const { result } = renderHook(() => useEntityPreview("product"));

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByTestId("preview-sheet")).toContainElement(
      screen.getByTestId("workbench-inspector"),
    );
  });

  it("keeps the legacy Sheet visible at mobile widths", () => {
    const { result } = renderHook(() => useEntityPreview("product"));

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByTestId("preview-sheet")).toContainElement(
      screen.getByTestId("workbench-inspector"),
    );
  });
});

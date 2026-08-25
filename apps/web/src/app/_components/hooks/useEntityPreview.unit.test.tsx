import type * as TanStackQuery from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
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

import { useEntityPreview } from "./useEntityPreview";

const row = (id: string) => ({ original: { id } });

describe("useEntityPreview intent prefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryClient.cancelQueries.mockClear();
    queryClient.prefetchQuery.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
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
});

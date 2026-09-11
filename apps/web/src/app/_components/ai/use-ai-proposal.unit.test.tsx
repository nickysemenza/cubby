import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAiProposal } from "./use-ai-proposal";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useAiProposal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops a response whose basis has moved on by the time it resolves", async () => {
    const first = defer<{ value: string }>();
    const run = vi.fn().mockReturnValue(first.promise);

    const { result, rerender } = renderHook(
      ({ basisKey }) => useAiProposal<{ value: string }>({ basisKey, run }),
      { initialProps: { basisKey: "a" } },
    );

    // Fired without awaiting completion: `first` doesn't resolve until
    // below, so awaiting the full `request()` here would deadlock.
    act(() => {
      void result.current.request();
    });
    expect(result.current.isLoading).toBe(true);

    // The basis moves on while the request is still in flight.
    rerender({ basisKey: "b" });

    await act(async () => {
      first.resolve({ value: "stale" });
      await first.promise;
    });

    expect(result.current.proposal).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("accept returns the pending result and clears the proposal", async () => {
    const run = vi.fn().mockResolvedValue({ value: "ok" });
    const { result } = renderHook(() =>
      useAiProposal<{ value: string }>({ basisKey: "a", run }),
    );

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.proposal?.result).toEqual({ value: "ok" });

    let accepted: { value: string } | null = null;
    act(() => {
      accepted = result.current.accept();
    });

    expect(accepted).toEqual({ value: "ok" });
    expect(result.current.proposal).toBeNull();
    // Calling accept again with nothing pending returns null rather than
    // throwing or resurrecting the cleared proposal.
    act(() => {
      accepted = result.current.accept();
    });
    expect(accepted).toBeNull();
  });

  it("clears an existing proposal when the basis changes", async () => {
    const run = vi.fn().mockResolvedValue({ value: "ok" });
    const { result, rerender } = renderHook(
      ({ basisKey }) => useAiProposal<{ value: string }>({ basisKey, run }),
      { initialProps: { basisKey: "a" } },
    );

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.proposal).not.toBeNull();

    rerender({ basisKey: "b" });

    expect(result.current.proposal).toBeNull();
  });

  it("dismiss clears the proposal without returning it", async () => {
    const run = vi.fn().mockResolvedValue({ value: "ok" });
    const { result } = renderHook(() =>
      useAiProposal<{ value: string }>({ basisKey: "a", run }),
    );

    await act(async () => {
      await result.current.request();
    });
    expect(result.current.proposal).not.toBeNull();

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.proposal).toBeNull();
  });

  it("surfaces a run error as a toast by default", async () => {
    const toastErrorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useAiProposal<{ value: string }>({ basisKey: "a", run }),
    );

    await act(async () => {
      await result.current.request();
    });

    expect(toastErrorSpy).toHaveBeenCalledTimes(1);
    expect(result.current.proposal).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("routes a run error to a caller-supplied onError instead of the default toast", async () => {
    const toastErrorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    const onError = vi.fn();
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useAiProposal<{ value: string }>({ basisKey: "a", run, onError }),
    );

    await act(async () => {
      await result.current.request();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });
});

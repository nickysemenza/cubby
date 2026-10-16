import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Visualization, visualizationState } from "./visualization";

function Engine() {
  const [selection, setSelection] = useState("none");
  return <button onClick={() => setSelection("selected")}>{selection}</button>;
}

describe("Visualization query presentation", () => {
  it("keeps the renderer and selection mounted through refresh failure and retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <Visualization state={{ status: "ready" }}>
        <Engine />
      </Visualization>,
    );
    fireEvent.click(screen.getByRole("button", { name: "none" }));
    const engine = screen.getByRole("button", { name: "selected" });
    rerender(
      <Visualization
        state={{
          status: "ready",
          refreshError: new Error("SQLSTATE 08006 synthetic refresh"),
          onRetry,
        }}
      >
        <Engine />
      </Visualization>,
    );
    expect(screen.getByRole("button", { name: "selected" })).toBe(engine);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SQLSTATE 08006 synthetic refresh",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(
      <Visualization state={{ status: "ready" }}>
        <Engine />
      </Visualization>,
    );
    expect(screen.getByRole("button", { name: "selected" })).toBe(engine);
  });

  it("shows initial errors and retry instead of loading, and never retains another scope", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <Visualization state={{ status: "ready" }}>
        <Engine />
      </Visualization>,
    );
    rerender(
      <Visualization
        state={visualizationState({
          data: undefined,
          isLoading: false,
          error: new Error("SQLSTATE 23514 synthetic scope"),
          onRetry,
          empty: false,
        })}
      >
        <Engine />
      </Visualization>,
    );
    expect(screen.queryByRole("button", { name: "none" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SQLSTATE 23514 synthetic scope",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("distinguishes successful empty results from loading and refresh errors", () => {
    const onRetry = vi.fn();
    expect(
      visualizationState({
        data: [],
        isLoading: false,
        error: null,
        empty: true,
        onRetry,
      }).status,
    ).toBe("empty");
    expect(
      visualizationState({
        data: undefined,
        isLoading: true,
        error: null,
        empty: false,
        onRetry,
      }).status,
    ).toBe("loading");
    expect(
      visualizationState({
        data: [],
        isLoading: false,
        error: new Error("synthetic refresh"),
        empty: true,
        onRetry,
      }).status,
    ).toBe("empty");
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderScalarValue } from "./scalar-value";

describe("structured scalar presentation", () => {
  const data = [{ source: "fixture", externalId: "ABC-123" }];

  it("summarizes compact values and reveals the full payload on demand", async () => {
    render(<>{renderScalarValue({ kind: "json", raw: data }, "list")}</>);
    expect(screen.getByRole("button", { name: /1 item/i })).toBeVisible();
    expect(screen.queryByText(/ABC-123/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 item/i }));
    expect(await screen.findByText(/ABC-123/)).toBeVisible();
  });

  it("collapses generic detail JSON until requested", () => {
    render(<>{renderScalarValue({ kind: "json", raw: data }, "detail")}</>);
    const disclosure = screen.getByText(/1 item/i).closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText(/1 item/i));
    expect(disclosure).toHaveAttribute("open");
    expect(disclosure).toHaveTextContent("ABC-123");
  });
});

// Cached records need no query rerender at midnight or on wake. Isolating the
// mounted cell prevents unrelated browser refetches from hiding a stale label.
describe("live calendar date labels", () => {
  afterEach(() => vi.useRealTimers());

  it("refreshes a mounted date cell at household midnight after DST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T06:59:59Z"));
    render(<>{renderScalarValue({ kind: "date", raw: "2026-03-08" })}</>);
    const cell = screen.getByTitle("Mar 8 (today)");
    expect(cell).toHaveTextContent("Mar 8 (today)");
    act(() => vi.advanceTimersByTime(1200));
    expect(cell).toHaveTextContent("Mar 8 (yesterday)");
  });

  it("refreshes a mounted future date after the page wakes days later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T19:00:00Z"));
    render(<>{renderScalarValue({ kind: "date", raw: "2026-10-06" })}</>);
    const cell = screen.getByTitle("Oct 6 (tomorrow)");
    expect(cell).toHaveTextContent("Oct 6 (tomorrow)");
    vi.setSystemTime(new Date("2026-10-07T19:00:00Z"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(cell).toHaveTextContent("Oct 6 (yesterday)");
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CurrencyValue } from "./currency-value";
import { renderScalarValue } from "./scalar-value";

describe("money and number tone", () => {
  it("keeps spend in ink, mutes a zero, and greens only a signed credit", () => {
    render(
      <>
        <span data-testid="spend">
          <CurrencyValue value={52.99} />
        </span>
        <span data-testid="zero">
          <CurrencyValue value={0} />
        </span>
        <span data-testid="credit">
          <CurrencyValue value={-12.5} />
        </span>
      </>,
    );
    const toneOf = (id: string) => screen.getByTestId(id).firstElementChild;
    expect(toneOf("spend")?.className ?? "").not.toMatch(/text-positive|muted/);
    expect(toneOf("zero")).toHaveClass("text-muted-foreground");
    expect(toneOf("credit")).toHaveClass("text-positive");
    expect(toneOf("credit")?.textContent).toMatch(/^[-−]/);
  });

  it("groups numbers and mutes zero", () => {
    render(
      <>
        {renderScalarValue({ kind: "number", raw: 12345 }, "list")}
        {renderScalarValue({ kind: "number", raw: 0 }, "list")}
      </>,
    );
    expect(screen.getByText("12,345")).toBeVisible();
    expect(screen.getByText("0")).toHaveClass("text-muted-foreground");
  });
});

describe("due dates", () => {
  afterEach(() => vi.useRealTimers());

  it("tints a passed deadline and says overdue, leaving other dates alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T19:00:00Z"));
    render(
      <>
        {renderScalarValue({ kind: "date", raw: "2026-10-17", due: true })}
        {renderScalarValue({ kind: "date", raw: "2026-10-12" })}
        {renderScalarValue({ kind: "date", raw: "2026-10-21", due: true })}
      </>,
    );
    const overdue = screen.getByTitle("Oct 17, 2026 · 2 days overdue");
    expect(overdue).toHaveClass("text-destructive");
    expect(overdue).toHaveAttribute("data-overdue");
    expect(screen.getByTitle(/^Oct 12, 2026/)).not.toHaveClass(
      "text-destructive",
    );
    expect(screen.getByTitle(/^Oct 21, 2026/)).not.toHaveAttribute(
      "data-overdue",
    );
  });
});

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
    const cell = screen.getByTitle("Mar 8, 2026 · today");
    expect(cell).toHaveTextContent("Mar 8, 2026 · today");
    act(() => vi.advanceTimersByTime(1200));
    expect(cell).toHaveTextContent("Mar 8, 2026 · yesterday");
  });

  it("refreshes a mounted future date after the page wakes days later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T19:00:00Z"));
    render(<>{renderScalarValue({ kind: "date", raw: "2026-10-06" })}</>);
    const cell = screen.getByTitle("Oct 6, 2026 · tomorrow");
    expect(cell).toHaveTextContent("Oct 6, 2026 · tomorrow");
    vi.setSystemTime(new Date("2026-10-07T19:00:00Z"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(cell).toHaveTextContent("Oct 6, 2026 · yesterday");
  });
});

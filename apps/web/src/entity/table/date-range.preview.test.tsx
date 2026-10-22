import type { CalendarDateRange } from "@cubby/schemas/date-range";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { DateDisplay } from "~/ui/common/date-display";

import { EditableDateRangeCell } from "./editable-cell";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function RangeCell({
  save,
  semantics,
}: {
  save: (value: CalendarDateRange | null) => void;
  semantics: "deadline" | "period";
}) {
  const [value, setValue] = useState<CalendarDateRange | null>({
    start: null,
    end: "2026-10-30",
  });
  return (
    <EditableDateRangeCell
      value={value}
      semantics={semantics}
      onSave={async (next) => {
        save(next);
        setValue(next);
      }}
      renderValue={() =>
        value ? (
          <DateDisplay start={value.start} end={value.end} />
        ) : (
          "Unscheduled"
        )
      }
    />
  );
}

// Scalar editor checks cannot catch a half-saved compound or focus/overflow
// failures across the nested range popover and cell overlay in a real browser.
for (const { width, semantics } of [
  { width: 1280, semantics: "deadline" },
  { width: 390, semantics: "period" },
] as const) {
  it(`replaces and clears both bounds atomically on ${width}px`, async () => {
    await page.viewport(width, 850);
    const save = vi.fn();
    render(<RangeCell save={save} semantics={semantics} />, {
      wrapper: harness.wrapper,
    });
    fireEvent.click(screen.getByRole("button", { name: /Oct/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Dates" }));
    const start = await screen.findByRole("textbox", { name: "Dates start" });
    fireEvent.change(start, { target: { value: "Oct 28, 2026" } });
    fireEvent.keyDown(start, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save value" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({
        start: "2026-10-28",
        end: "2026-10-30",
      }),
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    fireEvent.click(screen.getByRole("button", { name: /Oct/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Dates" }));
    if (semantics === "deadline")
      fireEvent.click(screen.getByRole("button", { name: "Single date" }));
    else fireEvent.click(screen.getByRole("button", { name: "Clear dates" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Oct/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Dates" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear dates" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save value" }));
    await screen.findByText("Unscheduled");
    expect(save).toHaveBeenLastCalledWith(null);
  });
}

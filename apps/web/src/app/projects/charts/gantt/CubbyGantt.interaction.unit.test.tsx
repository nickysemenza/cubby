import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CubbyGantt } from "./CubbyGantt";
import type { GanttRow } from "./gantt-model";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

const blocker: GanttRow = {
  kind: "task",
  id: "task-1",
  name: "Install cabinets",
  depth: 0,
  status: "done",
  startDay: 20_000,
  endDay: 20_000,
  trade: "cabinetry",
  blockedByIds: [],
  blockingIds: ["task-2"],
};

const dependent: GanttRow = {
  ...blocker,
  id: "task-2",
  name: "Fit doors",
  status: "not_started",
  startDay: 20_001,
  endDay: 20_001,
  blockedByIds: ["task-1"],
  blockingIds: [],
};

function renderGantt() {
  render(
    <CubbyGantt
      rows={[blocker, dependent]}
      window={{ startDay: 19_999, endDay: 20_010 }}
    />,
    { wrapper: harness.wrapper },
  );
  return screen.getByRole("button", {
    name: "Show 1 dependency relationship for Fit doors",
  });
}

describe("CubbyGantt dependency disclosure", () => {
  it("opens after focus and one pointer activation, then closes on the next", () => {
    const button = renderGantt();

    fireEvent.focus(button);
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Blocked by · 1")).toBeVisible();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles once for each keyboard-generated button activation", () => {
    const button = renderGantt();

    fireEvent.click(button, { detail: 0 });
    expect(button).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(button, { detail: 0 });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});

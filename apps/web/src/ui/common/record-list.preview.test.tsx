import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { DateDisplay } from "~/ui/common/date-display";

import {
  RecordFold,
  RecordGroup,
  RecordHeading,
  RecordHops,
  RecordList,
  RecordMore,
  RecordRow,
} from "./record-list";

const rect = (testId: string) =>
  screen.getByTestId(testId).getBoundingClientRect();

// Grouped rows share one grid, so trailing facts align across groups and the
// heading spans every column instead of claiming the identity track.
// Full timestamps must wrap on phone without pushing record identity offscreen.
it("aligns trailing facts across groups beneath full-width headings", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 640 }} data-testid="frame">
      <RecordList>
        <RecordGroup
          label="Synthetic tasks"
          count={4}
          more={<RecordMore label="+1 more" onClick={() => undefined} />}
        >
          <RecordRow
            data-testid="short-row"
            primary={<a href="/tasks/TSK-4K7M">Water</a>}
            secondary="via Planting"
            trailing={<RecordHops count={2} />}
          />
        </RecordGroup>
        <RecordGroup label="Synthetic purchases" count={1}>
          <RecordRow
            primary={<a href="/purchases/PUR-4K7M">A longer synthetic order</a>}
            secondary="via Product → Expense"
            trailing={<RecordHops count={3} />}
          />
        </RecordGroup>
        <RecordFold>No connections: Meals</RecordFold>
      </RecordList>
    </div>,
  );
  const hops = screen
    .getAllByText(/\d hops/u)
    .map((node) => node.closest("[data-ledger-slot]")!.getBoundingClientRect());
  expect(Math.abs(hops[0]!.right - hops[1]!.right)).toBeLessThanOrEqual(1);
  const frame = rect("frame");
  const heading = screen
    .getByText("Synthetic tasks")
    .closest("[data-ledger-slot]")!
    .getBoundingClientRect();
  expect(heading.width).toBeGreaterThanOrEqual(frame.width - 1);
  expect(rect("short-row").height).toBeLessThanOrEqual(30);
});

it("keeps phone rows with links at the touch floor", async () => {
  await page.viewport(390, 844);
  render(
    <RecordList>
      <RecordRow
        data-testid="phone-row"
        primary={<a href="/tasks/TSK-4K7M">Water</a>}
        trailing={<DateDisplay timestamp="2026-10-11T19:38:00.000Z" />}
      />
    </RecordList>,
  );
  expect(rect("phone-row").height).toBeGreaterThanOrEqual(44);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    window.innerWidth,
  );
  const instant = screen.getByTestId("phone-row").querySelector("time");
  if (!instant) throw new Error("missing full record timestamp");
  expect(instant.getBoundingClientRect().right).toBeLessThanOrEqual(
    window.innerWidth,
  );
});

it("draws the timeline rail through each row's dot", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 640 }}>
      <RecordList variant="timeline">
        <RecordHeading label="Oct 11, 2026" />
        <RecordRow
          data-testid="first"
          leading={<span data-testid="dot" className="size-2 rounded-full" />}
          primary="Updated"
        />
        <RecordRow leading={<span className="size-2" />} primary="Created" />
      </RecordList>
    </div>,
  );
  const leading = screen
    .getByTestId("dot")
    .closest("[data-ledger-slot]") as HTMLElement;
  const rail = getComputedStyle(leading, "::before");
  expect(rail.content).not.toBe("none");
  expect(Number.parseFloat(rail.height)).toBeGreaterThanOrEqual(
    rect("first").height,
  );
});

it("keeps loading, failure and emptiness distinct", () => {
  const { rerender } = render(<RecordList state={{ status: "pending" }} />);
  expect(screen.getByLabelText("Loading records")).toBeVisible();
  rerender(
    <RecordList
      state={{
        status: "error",
        error: new Error("Synthetic outage"),
        title: "records",
      }}
    />,
  );
  expect(screen.getByText(/Synthetic outage/u)).toBeVisible();
  rerender(<RecordList empty="No synthetic records.">{[]}</RecordList>);
  expect(screen.getByText("No synthetic records.")).toBeVisible();
});

// Regression: without a leading column the empty first track still took a
// column gap, indenting evidence and detail lines past their identity.
it("starts evidence and detail under identity when no row has a leading cell", async () => {
  await page.viewport(390, 844);
  render(
    <RecordList>
      <RecordRow
        primary={<span data-testid="identity">Synthetic gap</span>}
        secondary={<span data-testid="evidence">Missing a weight</span>}
        detail={<span data-testid="detail">Add a unit mapping</span>}
      />
    </RecordList>,
  );
  const identity = rect("identity").left;
  expect(Math.abs(rect("evidence").left - identity)).toBeLessThanOrEqual(1);
  expect(Math.abs(rect("detail").left - identity)).toBeLessThanOrEqual(1);
});

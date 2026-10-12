import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import {
  RecordFold,
  RecordGroup,
  RecordHeading,
  RecordHops,
  RecordList,
  RecordMore,
  RecordRow,
  RecordTime,
} from "./record-list";

const rect = (testId: string) =>
  screen.getByTestId(testId).getBoundingClientRect();

// Grouped rows share one grid, so trailing facts align across groups and the
// heading spans every column instead of claiming the identity track.
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
        trailing={<RecordTime at="2026-10-11T19:38:00.000Z" />}
      />
    </RecordList>,
  );
  expect(rect("phone-row").height).toBeGreaterThanOrEqual(44);
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

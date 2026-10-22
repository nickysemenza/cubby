import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { DateDisplay } from "~/ui/common/date-display";

import {
  RecordDot,
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
          leading={<RecordDot tone="muted" label="Updated" />}
          primary="Updated"
        />
        <RecordRow
          leading={<RecordDot tone="muted" label="Created" />}
          primary="Created"
        />
      </RecordList>
    </div>,
  );
  const first = screen.getByTestId("first");
  const rail = getComputedStyle(first, "::before");
  expect(rail.content).not.toBe("none");
  expect(Number.parseFloat(rail.height)).toBeGreaterThan(0);
  expect(
    Number.parseFloat(rail.top) + Number.parseFloat(rail.height),
  ).toBeGreaterThanOrEqual(first.getBoundingClientRect().height - 1);
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

it("places each fact under its column and keeps the label for assistive tech", async () => {
  await page.viewport(1440, 900);
  const { container } = render(
    <div style={{ width: 960 }}>
      <RecordList
        columns={[
          { id: "Amount", label: "Amount" },
          { id: "Location", label: "Location" },
        ]}
      >
        <RecordRow
          primary="Synthetic oats"
          facts={[
            { label: "Location", value: "Synthetic pantry" },
            { label: "Amount", value: "500 g" },
          ]}
        />
        <RecordRow
          primary="Synthetic lentils"
          facts={[{ label: "Location", value: "Synthetic shelf" }]}
        />
      </RecordList>
    </div>,
  );
  const header = container.querySelector("[data-ledger-header]");
  expect(header).toHaveAttribute("aria-hidden", "true");
  expect(header).toBeVisible();
  const column = (text: string) =>
    getComputedStyle(screen.getByText(text).closest("[data-fact]") as Element)
      .gridColumnStart;
  // Order in the row does not matter; the column id does.
  expect(column("500 g")).toBe("4");
  expect(column("Synthetic pantry")).toBe("5");
  expect(column("Synthetic shelf")).toBe("5");
  // The term stays in the accessibility tree even though the header shows it.
  expect(
    screen.getAllByText("Amount", { selector: "dt" }).length,
  ).toBeGreaterThan(0);
});

it("drops the header and shows labels inline in a narrow list", async () => {
  await page.viewport(1440, 900);
  const { container } = render(
    <div style={{ width: 320 }}>
      <RecordList columns={[{ id: "Amount", label: "Amount" }]}>
        <RecordRow
          primary="Synthetic oats"
          facts={[{ label: "Amount", value: "500 g" }]}
        />
      </RecordList>
    </div>,
  );
  expect(container.querySelector("[data-ledger-header]")).not.toBeVisible();
  expect(screen.getByText("Amount", { selector: "dt" })).toBeVisible();
});

// A dense section (duplicate spend names nine facts) must never scroll
// sideways where the columns layout begins, nor anywhere above it.
it.each([640, 720, 800])(
  "keeps nine fact columns inside a %ipx container",
  async (width) => {
    await page.viewport(1440, 900);
    const labels = [
      "Cost",
      "Matches stated total",
      "Vendor",
      "Purchase",
      "Expense date",
      "Purchase date",
      "Apart",
      "Weaker matches",
      "Location",
    ];
    render(
      <div style={{ width }} data-testid="dense">
        <RecordList columns={labels.map((label) => ({ id: label, label }))}>
          {[1, 2].map((row) => (
            <RecordRow
              key={row}
              leading={<span className="size-6" />}
              primary="Synthetic washer stacking bracket kit"
              secondary="EXP-0000"
              facts={labels.map((label) => ({
                label,
                value: `Synthetic value for ${label.toLowerCase()}`,
              }))}
              actions={<button type="button">Delete</button>}
            />
          ))}
        </RecordList>
      </div>,
    );
    const dense = screen.getByTestId("dense");
    expect(dense.scrollWidth).toBeLessThanOrEqual(dense.clientWidth);
  },
);

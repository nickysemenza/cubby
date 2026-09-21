import type { EntityTimelineOut } from "@cubby/schemas/entity-timeline";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityTimeline } from "~/entities/entity-timeline.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityTimeline } from "./entity-timeline";

const events: EntityTimelineOut = {
  groups: [
    {
      key: "purchase:PUR-2222",
      date: "2026-01-10",
      label: "Toolco · Order 42",
      link: { entity: "purchase", id: "PUR-2222" },
      events: [
        {
          id: "expense:EXP-2222",
          kind: "acquired",
          label: "Bench vise",
          amount: 120,
          link: { entity: "expense", id: "EXP-2222" },
          detail: "Acquired · 1 unit",
        },
        {
          id: "expense:EXP-3333",
          kind: "exited",
          label: "Sold the vise",
          amount: -80,
          link: { entity: "expense", id: "EXP-3333" },
        },
      ],
    },
  ],
  stats: [{ key: "movements", label: "Movements", value: "2" }],
  notes: ["1 planned movement is omitted."],
  extent: { from: "2026-01-10", to: "2026-03-01" },
};

const withRows: EntityTimelineOut = {
  ...events,
  rows: [
    {
      id: "PRD-2222",
      name: "Bench vise",
      link: { entity: "product", id: "PRD-2222" },
      intervals: [
        { start: "2026-01-10", end: "2026-02-01", confident: true },
        { start: "2026-02-01", end: null, confident: false },
      ],
      markers: [
        {
          date: "2026-01-10",
          kind: "acquired",
          link: { entity: "expense", id: "EXP-2222" },
        },
      ],
    },
    {
      // A guide row's identity is synthetic, so its separate explicit link is
      // the only valid navigation source.
      id: "guide-transplant:PLT-2222",
      name: "Recommended transplant · Tomato",
      link: { entity: "planting", id: "PLT-2222" },
      intervals: [{ start: "2026-02-01", end: "2026-02-28", confident: false }],
      markers: [],
    },
    {
      id: "guide-sow:PLT-2222",
      name: "Unlinked recommendation",
      intervals: [{ start: "2026-02-01", end: "2026-02-28", confident: false }],
      markers: [],
    },
  ],
};

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

const operationsFor = (out: EntityTimelineOut) => ({
  timeline: entityTimeline.timeline.withTransport(async () => out),
});

/**
 * The renderer's branches are data-driven: the mode switch exists only when
 * the capability supplies rows, amounts keep the ledger sign, and an
 * unconfident interval is drawn differently from a proven one.
 */
describe("EntityTimeline", () => {
  it("keeps unknown-date events after dated history in both views", async () => {
    const out: EntityTimelineOut = {
      ...withRows,
      groups: [
        ...withRows.groups,
        {
          key: "undated:EXP-4444",
          date: null,
          events: [
            { id: "EXP-4444", kind: "exited", label: "Discarded free tool" },
          ],
        },
      ],
    };
    render(
      <EntityTimeline
        entity="product"
        ids={["PRD-2222"]}
        operations={operationsFor(out)}
      />,
      { wrapper: harness.wrapper },
    );
    const unknown = await screen.findByRole("region", { name: "Date unknown" });
    expect(within(unknown).getByText("Discarded free tool")).toBeVisible();
    expect(
      screen.getByText("Toolco · Order 42").compareDocumentPosition(unknown) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lifecycles view" }));
    expect(
      within(screen.getByRole("region", { name: "Date unknown" })).getByText(
        "Discarded free tool",
      ),
    ).toBeVisible();
  });

  it("renders date groups with signed amounts and hides the mode switch without rows", async () => {
    render(
      <EntityTimeline
        entity="product"
        ids={["PRD-2222"]}
        operations={operationsFor(events)}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("Toolco · Order 42")).toBeInTheDocument();
    expect(screen.getByText("$120.00")).toBeInTheDocument();
    expect(screen.getByText("$80.00 recovered")).toBeInTheDocument();
    expect(screen.getByText("1 planned movement is omitted.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Bench vise" })).toHaveAttribute(
      "href",
      "/expenses/EXP-2222",
    );
    expect(
      screen.queryByRole("button", { name: "Lifecycles view" }),
    ).toBeNull();
  });

  it("switches to lifecycle rows and marks an unconfident span as inferred", async () => {
    render(
      <EntityTimeline
        entity="product"
        ids={["PRD-2222"]}
        operations={operationsFor(withRows)}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("Toolco · Order 42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lifecycles view" }));
    expect(await screen.findByText("Record")).toBeInTheDocument();
    expect(
      screen.getAllByTitle("Uncertain after Feb 1, 2026").length,
    ).toBeGreaterThan(0);
    expect(screen.getByTitle("Jan 10, 2026 – Feb 1, 2026")).toBeInTheDocument();
    expect(screen.getByText("Inferred")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Recommended transplant · Tomato" }),
    ).toHaveAttribute("href", "/plantings/PLT-2222");
    expect(screen.getByText("Unlinked recommendation").closest("a")).toBeNull();
  });
});

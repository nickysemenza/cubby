import { SECTION_ACTION_IDS } from "@cubby/schemas/entity-section-actions";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFeatures } from "~/features/registry";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RecordsBlockView } from "./records-block";
import { ReportTimeDisplay } from "./records-ledger";
import { sectionActionsFor } from "./section-actions";

installFeatures();

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

// A verb is a lazy chunk; the first transform of its dialog graph is slow.
const LAZY = { timeout: 20_000 };

describe("RecordsBlockView finance verbs", () => {
  it("states why a verb is unavailable instead of hiding it", async () => {
    render(
      <RecordsBlockView
        block={{
          kind: "records",
          rows: [],
          empty: "No purchase recorded.",
          actions: [],
          verbs: [
            {
              id: "splitExpense",
              label: "Split",
              scope: "section",
              disabledReason:
                "Record this expense's vendor first — a split files its parts under the same purchase.",
            },
          ],
        }}
        entity="expense"
        record={{ id: "EXP-2345" }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText("No purchase recorded.")).toBeInTheDocument();
    expect(
      screen.getByText(/Record this expense's vendor first/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Split/ }, LAZY),
    ).toBeDisabled();
  }, 30_000);
});

// A verb the server can offer with no web run would render as a dead button.
describe("section action registry", () => {
  it("implements every verb on some entity", () => {
    const entities = ["purchase", "expense"];
    const missing = SECTION_ACTION_IDS.filter(
      (id) => !entities.some((entity) => id in sectionActionsFor(entity)),
    );
    expect(missing).toEqual([]);
  });
});

describe("precision-aware report evidence", () => {
  it("keeps dates and local wall times out of instant formatting", () => {
    render(
      <>
        <ReportTimeDisplay time={{ kind: "date", value: "2026-01-05" }} />
        <ReportTimeDisplay
          time={{
            kind: "local",
            value: "2026-01-05 09:30",
            timezone: "America/Chicago",
          }}
        />
        <ReportTimeDisplay
          time={{ kind: "local", value: "09:30", timezone: null }}
        />
        <ReportTimeDisplay time={{ kind: "unknown" }} />
      </>,
    );
    expect(screen.getByText("Jan 5, 2026 (date only)")).toBeTruthy();
    expect(screen.getByText("2026-01-05 09:30 (America/Chicago)")).toBeTruthy();
    expect(screen.getByText("09:30 (timezone unknown)")).toBeTruthy();
    expect(screen.getByText("Event time unknown")).toBeTruthy();
  });

  it("labels receipt fallback and retains collapsed, navigable evidence", async () => {
    render(
      <RecordsBlockView
        block={{
          kind: "records",
          disclosureLabel: "Retained observations (1)",
          empty: "No evidence",
          rows: [
            {
              entity: null,
              id: null,
              title: "Fixture parcel update",
              trailing: null,
              time: { kind: "unknown", receiptAt: "2026-01-05T17:30:00Z" },
              lines: [
                {
                  text: "Fixture Email",
                  ref: { entity: "email", id: "EML-2345" },
                },
                {
                  text: "Carrier tracking",
                  url: "https://example.com/tracking/fixture",
                },
              ],
            },
          ],
        }}
      />,
      { wrapper: harness.wrapper },
    );
    const summary = screen.getByRole("button", {
      name: "Retained observations (1)",
    });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Fixture parcel update")).toBeNull();
    fireEvent.click(summary);
    expect(
      await screen.findByText(/Event time unknown.*Email received/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Carrier tracking/, hidden: true })
        .getAttribute("href"),
    ).toBe("https://example.com/tracking/fixture");
    expect(
      screen.getByText("Fixture Email").closest("a")?.getAttribute("href"),
    ).toContain("EML-2345");
  });
});

import { SECTION_ACTION_IDS } from "@cubby/schemas/entity-section-actions";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RecordsBlockView } from "./records-block";
import { sectionActionsFor } from "./section-actions";

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

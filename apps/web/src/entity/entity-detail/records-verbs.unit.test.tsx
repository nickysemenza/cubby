import { SECTION_ACTION_IDS } from "@cubby/schemas/entity-section-actions";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { type RecordsBlock, RecordsBlockView } from "./records-block";
import { sectionActionsFor } from "./section-actions";

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: (() => void) | undefined;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  restoreDispatch?.();
  harness.dispose();
});

const row = (
  key: string,
  overrides: Partial<RecordsBlock["rows"][number]> = {},
): RecordsBlock["rows"][number] => ({
  entity: null,
  id: null,
  title: `Charge ${key}`,
  subtitle: null,
  trailing: "$42.50",
  key,
  disabledReason: null,
  ...overrides,
});

const chargeSearch: RecordsBlock = {
  kind: "records",
  rows: [
    row("FTX-4K7M"),
    row("FTX-5N8P", {
      subtitle: "A search is already running for this charge.",
      disabledReason: "A search is already running for this charge.",
    }),
    row("FTX-6Q9R"),
  ],
  empty: "",
  actions: [],
  verbs: [
    {
      id: "searchCharges",
      label: "Search selected charges",
      scope: "selection",
      disabledReason: null,
    },
  ],
};

// A verb is a lazy chunk; the first transform of its dialog graph is slow.
const LAZY = { timeout: 20_000 };

describe("RecordsBlockView finance verbs", () => {
  it("starts a run for exactly the checked charges and never a refused one", async () => {
    const started = vi.fn();
    restoreDispatch = overrideStartDispatch(async (operation, input) => {
      if (operation === "vendor.startChargeRun") {
        started(input);
        return { ok: true, data: { runId: "RUN-4K7M" } };
      }
      throw new Error(`Unexpected operation ${operation}`);
    });
    render(
      <RecordsBlockView
        block={chargeSearch}
        entity="vendorAccount"
        record={{ id: "VACCT-4K7M" }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("checkbox", { name: "Select Charge FTX-5N8P" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      await screen.findByRole(
        "button",
        { name: "Search selected charges (0)" },
        LAZY,
      ),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Charge FTX-4K7M" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Charge FTX-6Q9R" }),
    );
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Search selected charges (2)" },
        LAZY,
      ),
    );

    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(started).toHaveBeenCalledWith({
      vendorAccountId: "VACCT-4K7M",
      transactionIds: ["FTX-4K7M", "FTX-6Q9R"],
    });
  });

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
    const entities = ["purchase", "expense", "vendorAccount"];
    const missing = SECTION_ACTION_IDS.filter(
      (id) => !entities.some((entity) => id in sectionActionsFor(entity)),
    );
    expect(missing).toEqual([]);
  });
});

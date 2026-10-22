import { financialTransactionOut } from "@cubby/schemas/financial-transaction";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { MatchStatementDialog } from "./match-statement";

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: (() => void) | undefined;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  restoreDispatch?.();
  harness.dispose();
});

const transaction = mock(financialTransactionOut, {
  seed: 7,
  overrides: {
    id: testShortcode("financialTransaction", "FTX-4K7M"),
    amount: 91,
    merchant: "Example Hardware",
    displayName: "Example Hardware",
    allocations: [],
    status: "posted",
    postedDate: "2026-03-04",
  },
});

const review = {
  advisory: true,
  message: null,
  candidates: [
    {
      transaction,
      days: 2,
      merchantMatches: true,
      exactAmount: true,
      nearAmount: false,
      conflicts: [],
      title: "Example Hardware",
      lines: ["Charge", "2026-03-04 · 2 days apart · vendor name matches"],
      proposedAllocations: [
        { purchaseId: "PUR-2345", amount: "42.50" },
        { purchaseId: "", amount: "48.50" },
      ],
    },
  ],
  tiedTransactionIds: [],
  suggestHint: null,
};

// Web and native both save only what `purchase.checkSettlementAllocation`
// returns, and never an allocation the server refused.
describe("MatchStatementDialog", () => {
  it("starts from the server's proposal and saves only the allocations the server validated", async () => {
    const updates = vi.fn();
    restoreDispatch = overrideStartDispatch(async (operation, input) => {
      if (operation === "purchase.settlementCandidates")
        return { ok: true, data: review };
      if (operation === "purchase.checkSettlementAllocation") {
        const { allocations } = z
          .object({
            allocations: z.array(z.object({ purchaseId: z.string() })),
          })
          .parse(input);
        const complete = allocations.every((row) => row.purchaseId !== "");
        return {
          ok: true,
          data: complete
            ? {
                allocations: [
                  { purchaseId: "PUR-2345", amount: 42.5 },
                  { purchaseId: "PUR-3456", amount: 48.5 },
                ],
                allocatedTotal: 91,
                remaining: 0,
                reason: null,
              }
            : {
                allocations: null,
                allocatedTotal: 42.5,
                remaining: 48.5,
                reason: "Row 2: enter a Purchase code such as PUR-4K7M.",
              },
        };
      }
      if (operation === "financialTransaction.allocateSettlement") {
        updates(input);
        return {
          ok: true,
          data: {
            transactionId: transaction.id,
            allocations: [
              { purchaseId: "PUR-2345", amount: 42.5 },
              { purchaseId: "PUR-3456", amount: 48.5 },
            ],
          },
        };
      }
      throw new Error(`Unexpected operation ${operation}`);
    });
    render(
      <MatchStatementDialog
        purchaseId="PUR-2345"
        open
        onOpenChange={vi.fn()}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: /\$91\.00/ }));
    expect(
      screen.getByRole("textbox", { name: "Purchase code 1" }),
    ).toHaveValue("PUR-2345");
    // The blank remainder row is the server's reason, and saving waits for it.
    expect(
      await screen.findByText("Row 2: enter a Purchase code such as PUR-4K7M."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save allocation" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Purchase code 2" }), {
      target: { value: "PUR-3456" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save allocation" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save allocation" }));

    await waitFor(() => expect(updates).toHaveBeenCalledOnce());
    expect(updates.mock.calls[0]?.[0]).toMatchObject({
      transactionId: "FTX-4K7M",
      priorAllocations: [],
      allocations: [
        { purchaseId: "PUR-2345", amount: 42.5 },
        { purchaseId: "PUR-3456", amount: 48.5 },
      ],
    });
  });

  it("keeps the selected graph and draft after a stale allocation refusal without retrying", async () => {
    const saves = vi.fn();
    const close = vi.fn();
    restoreDispatch = overrideStartDispatch(async (operation, input) => {
      if (operation === "purchase.settlementCandidates")
        return {
          ok: true,
          data: {
            ...review,
            candidates: [
              {
                ...review.candidates[0],
                proposedAllocations: [
                  { purchaseId: "PUR-2345", amount: "91.00" },
                ],
              },
            ],
          },
        };
      if (operation === "purchase.checkSettlementAllocation")
        return {
          ok: true,
          data: {
            allocations: [{ purchaseId: "PUR-2345", amount: 91 }],
            allocatedTotal: 91,
            remaining: 0,
            reason: null,
          },
        };
      if (operation === "financialTransaction.allocateSettlement") {
        saves(input);
        return {
          ok: false,
          error: {
            code: "BAD_REQUEST",
            reason: "CONSTRAINT_VIOLATION",
            message:
              "Settlement allocations changed after this proposal. SQLSTATE 40001 synthetic detail",
          },
        };
      }
      throw new Error(`Unexpected operation ${operation}`);
    });
    render(
      <MatchStatementDialog purchaseId="PUR-2345" open onOpenChange={close} />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(await screen.findByRole("button", { name: /\$91\.00/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save allocation" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save allocation" }));
    expect(
      await screen.findByText(
        "Settlement allocations changed after this proposal. SQLSTATE 40001 synthetic detail",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Purchase code 1" }),
    ).toHaveValue("PUR-2345");
    expect(saves).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  // Regression: the dialog is mounted (closed) on every Purchase detail; a debounce input that
  // is a fresh array each render re-rendered it every 250 ms forever.
  it("does not re-render while idle", async () => {
    restoreDispatch = overrideStartDispatch(async () => {
      throw new Error("a closed dialog must not read anything");
    });
    const commits = vi.fn();
    render(
      <Profiler id="idle" onRender={commits}>
        <MatchStatementDialog
          purchaseId="PUR-2345"
          open={false}
          onOpenChange={vi.fn()}
        />
      </Profiler>,
      { wrapper: harness.wrapper },
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(commits.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

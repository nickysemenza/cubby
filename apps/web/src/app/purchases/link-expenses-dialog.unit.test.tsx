import { purchaseOut } from "@cubby/schemas/purchase";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { LinkExpensesDialog } from "./link-expenses-dialog";

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: (() => void) | undefined;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  restoreDispatch?.();
  harness.dispose();
});

const purchase = mock(purchaseOut, {
  seed: 3,
  overrides: { id: testShortcode("purchase", "PUR-4K7M"), expenseTotal: 100 },
});

const candidate = (id: string, name: string, filed: boolean) => ({
  id,
  name,
  date: null,
  cost: 10,
  trade: null,
  projectId: null,
  projectName: null,
  current: filed ? "Sample Supply" : "unattached",
  filed,
  summary: name,
});

const candidates = {
  scopes: [{ value: "vendorOrUnattached", label: "This vendor or unattached" }],
  candidates: [
    candidate("EXP-2345", "Sample board", false),
    candidate("EXP-3456", "Sample screws", true),
  ],
  message: null,
  caution: "Attaching an already-filed expense moves it.",
};

const check = (ids: string[], confirm: string | null = null) => ({
  expenseIds: ids,
  selectedCount: ids.length,
  selectedTotal: ids.length * 10,
  resultingTotal: 100 + ids.length * 10,
  movedCount: confirm ? 1 : 0,
  reason: null,
  note: `${ids.length} selected`,
  confirm,
});

const idsOf = (input: unknown) =>
  z.object({ expenseIds: z.array(z.string()) }).parse(input).expenseIds;

const open = () =>
  render(
    <LinkExpensesDialog open onOpenChange={vi.fn()} purchase={purchase} />,
    { wrapper: harness.wrapper },
  );

// Attaching can move an expense off another purchase, so what is sent must be what the server
// checked for the selection as it is now, never an answer for an earlier selection.
describe("LinkExpensesDialog", () => {
  it("cannot attach while the check still describes an earlier selection", async () => {
    const links = vi.fn();
    let releaseSecond: (() => void) | undefined;
    let released = false;
    restoreDispatch = overrideStartDispatch(async (operation, input) => {
      if (operation === "purchase.linkExpenseCandidates")
        return { ok: true, data: candidates };
      if (operation === "purchase.checkLinkExpenses") {
        const ids = idsOf(input);
        if (ids.length === 2 && !released)
          await new Promise<void>((resolve) => {
            releaseSecond = () => {
              released = true;
              resolve();
            };
          });
        return { ok: true, data: check(ids) };
      }
      if (operation === "purchase.link") {
        links(input);
        return { ok: true, data: purchase };
      }
      throw new Error(`Unexpected operation ${operation}`);
    });
    open();

    await screen.findByText("Sample board");
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[1]!);
    await screen.findByText("1 selected");
    fireEvent.click(screen.getAllByRole("checkbox")[2]!);

    // The check for two expenses is still in flight; the one on screen is for one.
    expect(screen.getByRole("button", { name: "Attach 2" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Attach 2" }));
    expect(links).not.toHaveBeenCalled();

    releaseSecond?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Attach 2" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Attach 2" }));
    await waitFor(() => expect(links).toHaveBeenCalledOnce());
    expect(idsOf(links.mock.calls[0]?.[0]).sort()).toEqual([
      "EXP-2345",
      "EXP-3456",
    ]);
  });

  it("asks before moving an expense off another purchase", async () => {
    const links = vi.fn();
    const sentence = "Attaching moves 1 expense off its current purchase.";
    restoreDispatch = overrideStartDispatch(async (operation, input) => {
      if (operation === "purchase.linkExpenseCandidates")
        return { ok: true, data: candidates };
      if (operation === "purchase.checkLinkExpenses")
        return { ok: true, data: check(idsOf(input), sentence) };
      if (operation === "purchase.link") {
        links(input);
        return { ok: true, data: purchase };
      }
      throw new Error(`Unexpected operation ${operation}`);
    });
    open();

    await screen.findByText("Sample screws");
    fireEvent.click(screen.getAllByRole("checkbox")[2]!);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Attach 1" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Attach 1" }));

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(links).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Confirm/ }));
    await waitFor(() => expect(links).toHaveBeenCalledOnce());
    expect(idsOf(links.mock.calls[0]?.[0])).toEqual(["EXP-3456"]);
  });
});

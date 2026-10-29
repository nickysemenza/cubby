import type { AiFundingStatus } from "@cubby/schemas/mail-import-settings";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  AiFundingLine,
  AiFundingSettings,
  FundingBudgetEditor,
  PaidRunButton,
} from "./ai-funding";

const AVAILABLE = {
  state: "available",
  until: null,
  reason: null,
} as const;
const CONSOLE_LIMIT =
  '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}}';
const budget = (overrides: Partial<AiFundingStatus> = {}): AiFundingStatus => ({
  windowStart: "2026-10-01T00:00:00.000Z",
  windowEnd: "2026-10-01T06:00:00.000Z",
  credit: { limitUsd: 5, spentUsd: 2.5, ...AVAILABLE },
  openaiCredit: { limitUsd: 1.5, spentUsd: 0.25, ...AVAILABLE },
  paid: { limitUsd: 1, spentUsd: 0.4 },
  plan: { limitUsd: 2, spentUsd: 0.75, ...AVAILABLE },
  ...overrides,
});
const refused = budget({
  credit: {
    limitUsd: 5,
    spentUsd: 2.5,
    state: "refused",
    until: "2026-11-01T12:00:00.000Z",
    reason: CONSOLE_LIMIT,
  },
});

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  harness?.dispose();
  harness = undefined;
  restore = undefined;
});

// Failure modes: the card hides a budget, the plan state, or a credit refusal
// with Anthropic's raw reason; the refusal cannot be retried from Settings;
// window budgets cannot be edited; "paid allowed" pays without a
// confirmation, or past a spent paid budget without a second confirmation
// naming the amount.
describe("AI funding controls", () => {
  it("shows a credit refusal with its raw reason and retries Claude credit on request", async () => {
    harness = createBrowserTestHarness();
    const calls: string[] = [];
    restore = overrideOperationDispatch(async (operation) => {
      calls.push(operation);
      if (operation === "aiFunding.status") return { ok: true, data: refused };
      if (operation === "aiFunding.resetCreditRefusal")
        return { ok: true, data: budget() };
      throw new Error(`Unexpected ${operation}`);
    });
    render(<AiFundingSettings />, { wrapper: harness.wrapper });
    expect(await screen.findByText(/refused until Nov 1/u)).toBeVisible();
    expect(screen.getByText(CONSOLE_LIMIT)).toBeVisible();
    expect(screen.getByText("$0.40 of $")).toBeVisible();
    expect(screen.getByLabelText("Paid budget per window")).toHaveValue(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry Claude credit now" }),
    );
    expect(await screen.findAllByText("available")).not.toHaveLength(0);
    expect(calls).toContain("aiFunding.resetCreditRefusal");
    expect(
      screen.queryByRole("button", { name: "Retry Claude credit now" }),
    ).toBeNull();
  });

  it("summarizes funding in one line linking to Settings", () => {
    harness = createBrowserTestHarness();
    render(<AiFundingLine budget={refused} />, { wrapper: harness.wrapper });
    expect(screen.getByText(/Claude credit \$2\.50 of \$5\.00/u)).toBeVisible();
    expect(
      screen.getByText(/ChatGPT plan \$0\.75 of \$2\.00, available/u),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "AI funding" })).toHaveAttribute(
      "href",
      "/settings#ai-funding",
    );
  });

  // Unknown quota reset must still offer the provider's usage controls.
  it("offers Manage usage without inventing a plan reset", async () => {
    harness = createBrowserTestHarness();
    restore = overrideOperationDispatch(async () => ({
      ok: true,
      data: budget({
        plan: {
          limitUsd: 2,
          spentUsd: 0.5,
          state: "paused",
          until: null,
          reason: "synthetic quota refusal",
        },
      }),
    }));
    render(<AiFundingSettings />, { wrapper: harness.wrapper });
    expect(
      await screen.findByText(
        "ChatGPT plan usage limit reached; ChatGPT didn’t say when it resets",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Manage usage" }),
    ).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  });

  it("saves all four edited window budgets inline", () => {
    const onSave = vi.fn();
    render(
      <FundingBudgetEditor budget={budget()} pending={false} onSave={onSave} />,
    );
    fireEvent.change(screen.getByLabelText("Claude credit budget per window"), {
      target: { value: "7.5" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI credit budget per window"), {
      target: { value: "2.5" },
    });
    fireEvent.change(screen.getByLabelText("ChatGPT plan budget per window"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Paid budget per window"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budgets" }));
    expect(onSave).toHaveBeenCalledWith({
      creditLimitUsd: 7.5,
      openaiCreditLimitUsd: 2.5,
      planLimitUsd: 4,
      paidLimitUsd: 3,
    });
  });

  it("confirms paid funding within the paid budget once", async () => {
    const onConfirm = vi.fn();
    render(
      <PaidRunButton
        label="Run now, paid allowed"
        budget={budget()}
        pending={false}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Run now, paid allowed" }),
    );
    expect(await screen.findByText(/\$0\.40 of \$1\.00 used/u)).toBeVisible();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow paid models" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it.each([
    { limit: 0, spent: 0, grant: 1 },
    { limit: 1, spent: 1.05, grant: 1 },
    { limit: 100, spent: 100, grant: 10 },
  ])(
    "confirms a bounded grant past a spent $limit paid budget",
    async ({ limit, spent, grant }) => {
      const onConfirm = vi.fn();
      render(
        <PaidRunButton
          label="Run now, paid allowed"
          budget={budget({ paid: { limitUsd: limit, spentUsd: spent } })}
          pending={false}
          onConfirm={onConfirm}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Run now, paid allowed" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Allow paid models" }),
      );
      expect(onConfirm).not.toHaveBeenCalled();
      expect(await screen.findByText(/already spent/u)).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", {
          name: `Allow $${grant.toFixed(2)} over budget`,
        }),
      );
      expect(onConfirm).toHaveBeenCalledWith(grant);
    },
  );
});

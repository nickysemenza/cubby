import type { AiFundingStatus } from "@cubby/schemas/mail-import-settings";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  AiFundingLine,
  AiFundingSettings,
  CreditBudgetEditor,
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
// the credit budget cannot be edited; "paid allowed" pays without a
// confirmation, or past a spent paid budget without a second confirmation
// naming the amount.
describe("AI funding controls", () => {
  it("shows a credit refusal with its raw reason and retries Claude credit on request", async () => {
    harness = createBrowserTestHarness();
    const calls: string[] = [];
    restore = overrideStartDispatch(async (operation) => {
      calls.push(operation);
      if (operation === "aiFunding.status") return { ok: true, data: refused };
      if (operation === "aiFunding.resetCreditRefusal")
        return { ok: true, data: budget() };
      throw new Error(`Unexpected ${operation}`);
    });
    render(<AiFundingSettings />, { wrapper: harness.wrapper });
    expect(await screen.findByText(/refused until Nov 1/u)).toBeVisible();
    expect(screen.getByText(CONSOLE_LIMIT)).toBeVisible();
    expect(screen.getByText("$0.40 of $1.00")).toBeVisible();
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

  it("saves an edited credit budget", () => {
    const onSave = vi.fn();
    render(<CreditBudgetEditor limitUsd={5} pending={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Claude credit budget per window"), {
      target: { value: "7.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(7.5);
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

  it("asks again, naming the amount, before paying past a spent paid budget", async () => {
    const onConfirm = vi.fn();
    render(
      <PaidRunButton
        label="Run now, paid allowed"
        budget={budget({ paid: { limitUsd: 1, spentUsd: 1.05 } })}
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
    expect(
      await screen.findByText(/already spent \$1\.05 of \$1\.00/u),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Allow $1.00 over budget" }),
    );
    expect(onConfirm).toHaveBeenCalledWith(1);
  });
});

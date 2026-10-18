import type { AiFundingStatus } from "@cubby/schemas/mail-import-settings";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AiFundingSummary,
  CreditBudgetEditor,
  PaidRunButton,
} from "./ai-funding";

const budget = (overrides: Partial<AiFundingStatus> = {}): AiFundingStatus => ({
  windowStart: "2026-10-01T00:00:00.000Z",
  windowEnd: "2026-10-01T06:00:00.000Z",
  credit: { limitUsd: 5, spentUsd: 2.5 },
  paid: { limitUsd: 1, spentUsd: 0.4 },
  plan: { state: "available", until: null, reason: null },
  ...overrides,
});

// Failure modes: the card hides a budget or the plan state; the credit budget
// cannot be edited; "paid allowed" pays without a confirmation, or past a spent
// paid budget without a second confirmation naming the amount.
describe("AI funding controls", () => {
  it("shows both budgets and the plan state", () => {
    const { rerender } = render(<AiFundingSummary budget={budget()} />);
    expect(screen.getByText(/Claude credit \$2\.50 of \$5\.00/u)).toBeVisible();
    expect(screen.getByText(/Paid \$0\.40 of \$1\.00/u)).toBeVisible();
    expect(screen.getByText(/ChatGPT plan: available/u)).toBeVisible();
    rerender(
      <AiFundingSummary
        budget={budget({
          plan: {
            state: "paused",
            until: "2026-10-01T04:30:00.000Z",
            reason: "usage_limit_reached",
          },
        })}
      />,
    );
    expect(screen.getByText(/ChatGPT plan: paused until/u)).toBeVisible();
    rerender(
      <AiFundingSummary
        budget={budget({
          plan: {
            state: "needs_reauthorization",
            until: null,
            reason: "The household ChatGPT plan needs reauthorization.",
          },
        })}
      />,
    );
    expect(
      screen.getByText(/ChatGPT plan: needs reauthorization/u),
    ).toBeVisible();
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

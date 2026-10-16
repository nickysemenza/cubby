import type { DecisionStep } from "@cubby/schemas/decision-step";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { DecisionSteps } from "./decision-steps";

// Failure modes: opening a summary leaves multiple bodies visible, loses a
// draft on collapse, or strands keyboard focus on the disclosure trigger.
it("opens one body, focuses it, and preserves drafts across disclosures", () => {
  const steps: DecisionStep[] = [
    {
      key: "product",
      label: "Product",
      status: "done",
      summary: "Synthetic drill",
      action: "link",
      blockedReason: null,
    },
    {
      key: "identity",
      label: "Right one?",
      status: "needs_input",
      summary: null,
      action: null,
      blockedReason: null,
    },
    {
      key: "apply",
      label: "Apply",
      status: "blocked",
      summary: null,
      action: "create",
      blockedReason: "Check identity first",
    },
  ];
  render(
    <DecisionSteps
      steps={steps}
      renderBody={(step) => (
        <input aria-label={`${step.label} draft`} defaultValue="" />
      )}
    />,
  );
  const draft = screen.getByRole("textbox", { name: "Right one? draft" });
  fireEvent.change(draft, { target: { value: "Keep this answer" } });
  fireEvent.click(screen.getByRole("button", { name: "Change Product" }));
  expect(screen.getByRole("textbox", { name: "Product draft" })).toHaveFocus();
  expect(draft).not.toBeVisible();
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Open Right one?" }));
  expect(draft).toBeVisible();
  expect(draft).toHaveValue("Keep this answer");
  expect(draft).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Close Right one?" }));
  expect(draft).not.toBeVisible();
});

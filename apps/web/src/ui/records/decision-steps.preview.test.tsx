import type { DecisionStep } from "@cubby/schemas/decision-step";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { DecisionSteps } from "./decision-steps";

// Failure modes: an answered row grows beyond the dense ledger footprint,
// phone disclosure targets shrink below 44px, or media squeezes phone rows.
it("keeps desktop summaries at 28px and phone actions at 44px with media above", async () => {
  await page.viewport(1440, 900);
  const steps: DecisionStep[] = [
    {
      key: "product",
      label: "Product",
      status: "done",
      summary: "Synthetic trail shoes · size 10",
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
  ];
  render(
    <div style={{ maxWidth: 680 }}>
      <DecisionSteps
        steps={steps}
        media={<div data-testid="media">Synthetic photo evidence</div>}
        renderBody={() => <input aria-label="Identity answer" />}
      />
    </div>,
  );
  const change = screen.getByRole("button", { name: "Change Product" });
  expect(change.closest("li")?.getBoundingClientRect().height).toBe(28);
  await page.viewport(402, 874);
  expect(change.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  const media = screen.getByTestId("media").getBoundingClientRect();
  expect(media.bottom).toBeLessThanOrEqual(change.getBoundingClientRect().top);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(402);
});

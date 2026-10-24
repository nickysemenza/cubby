import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RunTargetsTable } from "./run-targets";
import type { RunTarget } from "./run-targets-model";

const target: RunTarget = {
  id: "synthetic-target",
  targetType: "product",
  targetShortcode: "PRD-4K7M",
  targetName: "Synthetic lamp",
  sourceId: null,
  sourceLabel: "Example catalog",
  vendorAccountLabel: null,
  state: "unresolved",
  fingerprint: null,
  outcome: "Waiting for evidence",
  warning: null,
  diff: null,
  completedAt: null,
};

it("retains resolved attention evidence and holds arrivals until acknowledged", async () => {
  await page.viewport(1440, 1200);
  const harness = createBrowserTestHarness();
  try {
    const view = render(<RunTargetsTable rows={[target]} />, {
      wrapper: harness.wrapper,
    });
    await userEvent.click(
      await screen.findByRole("row", { name: /Waiting for evidence/ }),
    );
    expect(
      await screen.findByRole("complementary", { name: "Run target evidence" }),
    ).toBeVisible();
    const resolved = {
      ...target,
      state: "completed",
      outcome: "Evidence retained",
    };
    const arrival = {
      ...target,
      id: "synthetic-new",
      targetName: "Synthetic chair",
      targetShortcode: "PRD-4K7N",
    };
    view.rerender(<RunTargetsTable rows={[arrival, resolved]} />);
    const inspector = await screen.findByRole("complementary", {
      name: "Run target evidence",
    });
    expect(
      await within(inspector).findByText("Evidence retained"),
    ).toBeVisible();
    expect(
      screen.getByRole("row", { name: /Evidence retained/ }),
    ).toBeVisible();
    expect(screen.queryByRole("row", { name: /Synthetic chair/ })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 new items" }),
    );
    expect(
      await screen.findByRole("row", { name: /Synthetic chair/ }),
    ).toBeVisible();
  } finally {
    harness.dispose();
  }
});

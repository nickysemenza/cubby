import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { MonthlySpendChart } from "./spend-chart";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

// SQL owns monthly sums; native layout must keep edge readouts and roving focus usable.
it("keeps spend readouts outside clipping and one keyboard stop at both edges", async () => {
  await page.viewport(1280, 900);
  const restore = overrideOperationDispatch(async (operation) => {
    if (operation !== "entity.monthlyExpenseSpend")
      throw new Error(`Unexpected chart operation ${operation}`);
    return {
      ok: true,
      data: Array.from({ length: 12 }, (_, index) => ({
        month: `2026-${String(index + 1).padStart(2, "0")}`,
        cents: index === 11 ? 4200 : 0,
      })),
    };
  });
  try {
    render(
      <div className="overflow-hidden">
        <MonthlySpendChart
          entity="product"
          compact
          id={testShortcode("product", "PRD-4K7M")}
        />
      </div>,
      { wrapper: harness.wrapper },
    );
    const chart = await screen.findByTestId("monthly-spend-chart");
    const bars = await within(chart).findAllByRole("img");
    expect(bars).toHaveLength(12);
    expect(chart.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    bars[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(bars[1]).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(bars[0]).toHaveFocus();
    const readout = async (bar: HTMLElement) => {
      const label = bar.getAttribute("aria-label");
      if (!label) throw new Error("Spend bar is missing its accessible value");
      await waitFor(() => {
        const tooltip = document.querySelector('[role="tooltip"][data-open]');
        expect(tooltip).toBeVisible();
        expect(tooltip).toHaveTextContent(label.replace(" spend:", " ·"));
        expect(
          tooltip?.closest('[data-testid="monthly-spend-chart"]'),
        ).toBeNull();
        const bounds = tooltip!.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(1280);
      });
    };
    await readout(bars[0]!);
    await userEvent.keyboard("{End}");
    expect(bars.at(-1)).toHaveFocus();
    await readout(bars.at(-1)!);
    expect(chart.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  } finally {
    restore();
  }
});

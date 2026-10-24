import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RunWorkspacePrototype } from "./run-workspace.prototype";

let harness: ReturnType<typeof createBrowserTestHarness>;
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  harness?.dispose();
});

it.each([1440, 402])(
  "exercises the synthetic Run workspace at %s",
  async (width) => {
    await page.viewport(width, 1100);
    harness = createBrowserTestHarness();
    const counts = Object.fromEntries(
      Object.keys(dashboardCountsOut.shape)
        .filter((key) => key !== "usdaFoodsAvailable")
        .map((key) => [key, 0]),
    );
    restore = overrideStartDispatch(async (operation) => {
      if (operation === "maintenance.requestCatchUp")
        return { ok: true, data: { status: "recent" } };
      if (operation === "dashboard.counts") return { ok: true, data: counts };
      throw new Error(`Prototype blocked ${operation}`);
    });
    render(<RunWorkspacePrototype />, { wrapper: harness.wrapper });
    expect(
      await screen.findByRole("heading", { name: "Email purchase import" }),
    ).toBeVisible();
    expect(
      document.querySelector('[data-app-shell="authenticated"]'),
    ).not.toBeNull();
    await page.screenshot({
      path: `/Users/nicky/.t3/worktrees/cubby/t3-c6cc09f5/artifacts/run-prototype-email-${width}.png`,
      fullPage: true,
    });
    const search = screen.getByPlaceholderText("Search results");
    await userEvent.fill(search, "Sample Market");
    expect(
      await screen.findByRole("button", { name: "Apply 0 filtered ready" }),
    ).toBeDisabled();
    await userEvent.clear(search);
    await userEvent.click(
      await screen.findByRole("button", { name: "Apply 1 filtered ready" }),
    );
    expect(screen.getByText("Applied 1 filtered ready results.")).toBeVisible();
    const reviewRow =
      width >= 768
        ? screen.getByRole("row", { name: /Sample Market receipt/ })
        : screen.getByRole("button", { name: /Sample Market receipt/ });
    await userEvent.click(reviewRow);
    const inspector = await screen.findByRole("complementary", {
      name: "Result inspector",
    });
    await waitFor(() =>
      expect(within(inspector).getByText("Your decision")).toBeVisible(),
    );
    await page.screenshot({
      path: `/Users/nicky/.t3/worktrees/cubby/t3-c6cc09f5/artifacts/run-prototype-inspector-${width}.png`,
      fullPage: true,
    });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Simulate new arrival" }),
    );
    expect(screen.getByText(/Your review stays in place/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Show new result" }),
    );
    expect(
      await screen.findByRole("button", { name: "Apply 1 filtered ready" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Photo review" }));
    expect(
      await screen.findByRole("heading", { name: "Photo inventory review" }),
    ).toBeVisible();
    await page.screenshot({
      path: `/Users/nicky/.t3/worktrees/cubby/t3-c6cc09f5/artifacts/run-prototype-photo-${width}.png`,
      fullPage: true,
    });
    const photoRow =
      width >= 768
        ? screen.getByRole("row", { name: /Two matching storage boxes/ })
        : screen.getByRole("button", { name: /Two matching storage boxes/ });
    await userEvent.click(photoRow);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Photo group evidence" }),
      ).toBeVisible(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect photograph 3" }),
    );
    expect(
      screen.getByText("Side view: matching labels and shelf position."),
    ).toBeVisible();
    await page.screenshot({
      path: `/Users/nicky/.t3/worktrees/cubby/t3-c6cc09f5/artifacts/run-prototype-photo-inspector-${width}.png`,
      fullPage: true,
    });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Enrichment" }));
    expect(
      await screen.findByRole("heading", { name: "Product enrichment" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Results · 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.screenshot({
      path: `/Users/nicky/.t3/worktrees/cubby/t3-c6cc09f5/artifacts/run-prototype-enrichment-${width}.png`,
      fullPage: true,
    });
  },
);

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  loadJourneyIds,
  replayParams,
} from "../../tooling/tester-army/journey";
import { readBrowserCookies } from "../../tooling/tester-army/scenario";

if (process.env.TESTER_ARMY_WEB_MODE === "explore") {
  test.setup(
    "synthetic cookie authentication",
    { sessions: ["synthetic"], agent: "explorer" },
    async ({ browser, app, session }) => {
      await browser.setCookies(readBrowserCookies());
      await app.open("/expenses");
      await expect(browser.locator("[data-hydrating]")).toHaveCount(0);
      await session.save("synthetic");
    },
  );
} else {
  test("source claim editor layout", async ({
    browser,
    app,
    agent,
    screen,
  }) => {
    const ids = loadJourneyIds("field-source-claim");
    await browser.setCookies(readBrowserCookies());
    await app.open(`/expenses/${ids.get("expense")}`);
    await expect(browser.locator("[data-hydrating]")).toHaveCount(0);
    await agent.act("Open the Edit Expense dialog and leave it open.", {
      params: replayParams(ids),
    });
    const editor = screen.getByRole("dialog", {
      name: "Edit Expense",
      exact: true,
    });
    const description = editor.getByRole("textbox", {
      name: "Description",
      exact: true,
    });
    await description.scrollIntoView();
    await expect(description).toBeVisible();
    await expect(description).toHaveValue("Synthetic claim evidence");
    await expect(editor).toHaveScreenshot("source-claim-editor-desktop");
  });

  test("cent short split refusal layout", async ({
    browser,
    app,
    agent,
    screen,
  }) => {
    const ids = loadJourneyIds("finance-split-expense");
    await browser.setCookies(readBrowserCookies());
    await app.open(`/expenses/${ids.get("expense")}`);
    await expect(browser.locator("[data-hydrating]")).toHaveCount(0);
    await screen.getByRole("button", { name: "Split...", exact: true }).tap();
    await agent.act(
      'Set Part 1 name to "Synthetic part one", Part 1 cost to 6.00, Part 2 name to "Synthetic part two", and Part 2 cost to 4.00. Leave the Split dialog open.',
      { params: replayParams(ids) },
    );
    const dialog = screen.getByRole("dialog");
    await expect(
      dialog.getByText("$0.01 under the original", { exact: false }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Split into 2", exact: true }),
    ).toBeDisabled();
    await expect(dialog).toHaveScreenshot("split-cent-refusal-desktop");
  });

  test("inventory empty state at phone width", async ({
    browser,
    app,
    screen,
  }) => {
    await browser.setCookies(readBrowserCookies());
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/inventory");
    await expect(browser.locator("[data-hydrating]")).toHaveCount(0);
    await expect(
      screen.getByRole("heading", { name: "Inventory", exact: true }),
    ).toBeVisible();
    await expect(screen).toHaveScreenshot("inventory-empty-phone", {
      mask: [browser.locator('a[href^="/inventory/"], time')],
    });
  });
}

import type { NativeWorkspaceMessage } from "~/lib/native-workspace";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { fixtureUserId, getFixtureDb } from "./fixtures-core";
import { expect, test } from "./e2e-test";
import { seedProductPrerequisite } from "./fixtures-catalog";

declare global {
  interface Window {
    workspaceTestMessages: NativeWorkspaceMessage[];
  }
}

// Regression boundaries: ambient browser cookies must not choose bootstrap
// identity; missing/invalid native credentials must fail; installing the
// returned cookie must authenticate the actual hosted document without a
// second login, and record links must hand off rather than navigate the SPA.
test("Run evidence uses native bearer cookies and confines the hosted experiment", async ({
  page: authenticatedPage,
  browser,
  baseURL,
  e2eRuntime,
}, testInfo) => {
  const unauthenticated = await authenticatedPage.request.post(
    "/api/native-workspace/session",
  );
  expect(unauthenticated.status()).toBe(401);
  const invalid = await authenticatedPage.request.post(
    "/api/native-workspace/session",
    {
      headers: { Authorization: "Bearer invalid.signature" },
    },
  );
  expect(invalid.status()).toBe(401);
  const cookie = e2eRuntime.storageState.cookies.find((entry) =>
    entry.name.endsWith("session_token"),
  );
  expect(cookie).toBeDefined();
  const product = await seedProductPrerequisite(authenticatedPage, {
    name: "Workspace drill",
  });
  const actorUserId = await fixtureUserId(authenticatedPage);
  const run = await insertWithShortcode(getFixtureDb(), "run", {
    actorUserId,
    actorName: "Fixture agent",
    actorEmail: "agent@example.test",
    purpose: "background",
    trigger: "manual",
    status: "completed",
    startedAt: new Date("2026-09-01T10:00:00Z"),
    endedAt: new Date("2026-09-01T10:01:00Z"),
  });
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const response = await context.request.post("/api/native-workspace/session", {
    headers: { Authorization: `Bearer ${decodeURIComponent(cookie!.value)}` },
  });
  expect(response.status()).toBe(204);
  expect(response.headers()["set-cookie"]).toContain("HttpOnly");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect((await context.cookies()).map((entry) => entry.name)).toEqual([
    cookie!.name,
  ]);
  await page.addInitScript(() => {
    const messages: NativeWorkspaceMessage[] = [];
    Object.defineProperty(window, "workspaceTestMessages", { value: messages });
    Object.defineProperty(window, "webkit", {
      value: {
        messageHandlers: {
          cubbyWorkspace: {
            postMessage: (message: NativeWorkspaceMessage) =>
              messages.push(message),
          },
        },
      },
    });
  });
  await page.goto(`/${run.shortcode}?nativeWorkspace=run-evidence#evidence`);
  await expect(page.locator("[data-native-workspace]")).toBeVisible();
  await expect(page.locator("[data-run-evidence]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Evidence",
  );
  await expect(
    page.getByRole("tab", { name: "Overview", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-app-shell="authenticated"]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.workspaceTestMessages))
    .toContainEqual({ version: 1, type: "ready" });
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const pilotURL = page.url();
  const runsLink = page.getByRole("link", { name: "Runs", exact: true });
  await runsLink.click();
  await expect(page).toHaveURL(pilotURL);
  await expect(page.locator("[data-run-evidence]")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("run-evidence-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-run-evidence]")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("run-evidence-phone.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  // The pilot flag cannot turn an ordinary record into a hosted workspace.
  await page.goto(`/${product.id}?nativeWorkspace=run-evidence`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace drill" }),
  ).toBeVisible();
  await expect(page.locator("[data-native-workspace]")).toHaveCount(0);
  await expect(page.locator('[data-app-shell="authenticated"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("product-workspace-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("tab", { name: "Work", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await expect(page).toHaveURL(/#work$/u);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("product-workspace-phone.png"),
    fullPage: true,
  });
  await context.close();
});

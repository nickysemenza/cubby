import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("settings explains local authorization and exposes no model selectors", async ({
  page,
  request,
}) => {
  const status = await request.get("/api/ai/chatgpt");
  expect(status.ok()).toBe(true);
  expect(await status.json()).toEqual({
    connected: false,
    email: null,
    needsReauthorization: false,
  });
  const host = await request.get("/api/v1/chatgpt/authorizationHost");
  expect(host.ok()).toBe(true);
  expect(await host.json()).toMatchObject({ clientId: null });
  const rejectedConnect = await request.post("/api/v1/chatgpt/connect", {
    headers: { Authorization: "Bearer invalid-example" },
    data: {},
  });
  expect(rejectedConnect.status()).toBe(401);
  const rejectedBearer = await request.get("/api/ai/chatgpt", {
    headers: { Authorization: "Bearer invalid-example" },
  });
  expect(rejectedBearer.status()).toBe(401);
  const crossOrigin = await request.delete("/api/ai/chatgpt", {
    headers: { Origin: "https://untrusted.example.com" },
  });
  expect(crossOrigin.status()).toBe(403);
  await gotoAuthenticatedPage(page, "/settings");
  const card = page.getByTestId("chatgpt-plan");
  await expect(
    card.getByRole("heading", { name: "ChatGPT plan" }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect(
    card.getByText(/pnpm apple cli chatgpt connect --base-url/),
  ).toBeVisible();
  await expect(card.getByRole("combobox")).toHaveCount(0);
});

test("settings renders the complete returned catalog, refresh errors, and disconnect", async ({
  page,
}, testInfo) => {
  // External account access cannot run in CI. The browser receives synthetic
  // catalog responses; credential rotation has its own focused regression.
  let connected = true;
  let failed = false;
  await page.route("**/api/ai/chatgpt*", async (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      connected = false;
      await route.fulfill({ json: { disconnected: true } });
    } else if (request.url().includes("models")) {
      await route.fulfill(
        failed
          ? {
              status: 403,
              json: {
                error: "OpenAI HTTP 403: example eligibility restriction",
              },
            }
          : {
              json: [
                {
                  slug: "gpt-6-luna",
                  display_name: "GPT-6 Luna",
                  visibility: "list",
                },
                {
                  slug: "gpt-6-sol",
                  display_name: "GPT-6 Sol",
                  visibility: "list",
                },
                {
                  slug: "example-future-model",
                  display_name: "Example future model",
                  visibility: "list",
                },
              ],
            },
      );
    } else
      await route.fulfill({
        json: { connected, email: connected ? "user@example.com" : null },
      });
  });
  await gotoAuthenticatedPage(page, "/settings");
  const card = page.getByTestId("chatgpt-plan");
  await expect(
    card.getByText("example-future-model", { exact: true }),
  ).toBeVisible();
  await expect(card.getByRole("combobox")).toHaveCount(0);
  await expect(
    card.getByRole("link", { name: "Manage usage" }),
  ).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  await testInfo.attach("chatgpt-models-desktop", {
    body: await card.screenshot(),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    card.getByText("example-future-model", { exact: true }),
  ).toBeVisible();
  await testInfo.attach("chatgpt-models-phone", {
    body: await card.screenshot(),
    contentType: "image/png",
  });
  failed = true;
  await card.getByRole("button", { name: "Refresh models" }).click();
  await expect(card.getByText(/example eligibility restriction/)).toBeVisible();
  await card.getByRole("button", { name: "Disconnect ChatGPT" }).click();
  await expect(
    card.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toBeVisible();
  await expect(
    card.getByText("example-future-model", { exact: true }),
  ).toHaveCount(0);
});

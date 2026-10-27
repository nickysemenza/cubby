import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

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
    issue: null,
    welcomeDismissed: false,
  });
  // A cookie request that can act must name this origin.
  const host = await request.post("/api/operations/chatgpt.authorizationHost", {
    headers: { Origin: new URL(status.url()).origin },
    data: { operation: "chatgpt.authorizationHost" },
  });
  expect(host.ok()).toBe(true);
  expect((await host.json()).data).toMatchObject({ clientId: null });
  const rejectedConnect = await request.post(
    "/api/operations/chatgpt.connect",
    {
      headers: { Authorization: "Bearer invalid-example" },
      data: { operation: "chatgpt.connect", input: {} },
    },
  );
  expect(rejectedConnect.status()).toBe(401);
  const rejectedBearer = await request.get("/api/ai/chatgpt", {
    headers: { Authorization: "Bearer invalid-example" },
  });
  expect(rejectedBearer.status()).toBe(401);
  const crossOriginDismiss = await request.patch("/api/ai/chatgpt", {
    headers: { Origin: "https://untrusted.example.com" },
  });
  expect(crossOriginDismiss.status()).toBe(403);
  const dismissed = await request.patch("/api/ai/chatgpt", {
    headers: { Origin: new URL(status.url()).origin },
  });
  expect(dismissed.ok()).toBe(true);
  expect(await dismissed.json()).toMatchObject({
    connected: false,
    welcomeDismissed: false,
  });
  const crossOrigin = await request.delete("/api/ai/chatgpt", {
    headers: { Origin: "https://untrusted.example.com" },
  });
  expect(crossOrigin.status()).toBe(403);
  await gotoAuthenticatedPage(page, "/settings");
  const card = page.getByRole("region", { name: "ChatGPT plan", exact: true });
  await expect(
    card.getByRole("heading", { name: "ChatGPT plan" }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect(
    card.getByText(/pnpm apple cli chatgpt connect --base-url/),
  ).toBeVisible();
  await expect(
    card.getByText(/background work continues on paid billing/u),
  ).toHaveCount(0);
  await expect(card.getByRole("combobox")).toHaveCount(0);
});

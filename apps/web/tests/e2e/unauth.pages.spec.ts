import { expect, test } from "./support/e2e-test";

test.use({ signedIn: false });

test("public home renders and protected detail redirects before rendering", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Cubby/i);

  await page.goto("/products/PRD-2222");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
});

test("anonymous OAuth registration lazily seeds the configured MCP resource", async ({
  request,
}) => {
  const response = await request.post("/api/auth/oauth2/register", {
    data: {
      application_type: "native",
      client_name: "Cubby E2E MCP Client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["http://127.0.0.1/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });

  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({
    resources: ["https://cubby.nickysemenza.com/api/mcp"],
  });
});
